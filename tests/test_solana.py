"""Solana freeze/thaw instruction parsing and the adapter's cursor logic over
a fake RPC. The transaction here is constructed in the jsonParsed shape the
RPC returns for spl-token instructions."""

from freeze_ledger.adapters.solana import SolanaAdapter, parse_freeze_instructions
from freeze_ledger.normalize import b58encode
from freeze_ledger.registry import SOLANA_MINTS
from tests.conftest import FakeRpc, quiet

USDC = next(m for m in SOLANA_MINTS if m.token == "USDC")
# syntactically valid 32-byte keys for the fake authority, token account and owner
AUTH = b58encode(b"\x01" * 32)
TOKEN_ACCOUNT = b58encode(b"\x02" * 32)
OWNER = b58encode(b"\x03" * 32)


def fake_tx(slot=250_000_000, block_time=1_700_000_000, with_inner=False):
    keys = [AUTH, TOKEN_ACCOUNT, USDC.mint, "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"]
    outer = [
        {
            "program": "spl-token",
            "programId": keys[3],
            "parsed": {"type": "freezeAccount", "info": {"account": TOKEN_ACCOUNT, "mint": USDC.mint, "freezeAuthority": AUTH}},
        }
    ]
    inner = []
    if with_inner:
        inner = [
            {
                "index": 0,
                "instructions": [
                    {
                        "program": "spl-token",
                        "programId": keys[3],
                        "parsed": {"type": "thawAccount", "info": {"account": TOKEN_ACCOUNT, "mint": USDC.mint, "freezeAuthority": AUTH}},
                    }
                ],
            }
        ]
    return {
        "slot": slot,
        "blockTime": block_time,
        "transaction": {"message": {"accountKeys": [{"pubkey": k} for k in keys], "instructions": outer}},
        "meta": {
            "innerInstructions": inner,
            "postTokenBalances": [{"accountIndex": 1, "mint": USDC.mint, "owner": OWNER, "uiTokenAmount": {"amount": "1"}}],
        },
    }


def test_parse_outer_and_inner_instructions_with_owner_resolution():
    found = parse_freeze_instructions(fake_tx(with_inner=True), USDC.mint)
    assert [f["action"] for f in found] == ["freeze", "unfreeze"]
    assert found[0]["account"] == TOKEN_ACCOUNT and found[0]["owner"] == OWNER
    assert found[0]["position"] == 0 and found[1]["position"] == 1


def test_other_mints_are_ignored():
    tx = fake_tx()
    tx["transaction"]["message"]["instructions"][0]["parsed"]["info"]["mint"] = "So11111111111111111111111111111111111111112"
    assert parse_freeze_instructions(tx, USDC.mint) == []


def _rpc(sigs_pages, tx):
    state = {"page": 0}

    def get_sigs(params):
        opts = params[1]
        # emulate `before` paging: first call -> page 0, next -> page 1 ...
        i = state["page"]
        state["page"] += 1
        return sigs_pages[i] if i < len(sigs_pages) else []

    def get_account_info(params):
        if params[0] == USDC.mint:
            return {"value": {"data": {"parsed": {"info": {"freezeAuthority": AUTH}}}}}
        return {"value": {"data": {"parsed": {"info": {"owner": OWNER}}}}}

    return FakeRpc({"getAccountInfo": get_account_info, "getSignaturesForAddress": get_sigs, "getTransaction": lambda p: tx})


def test_adapter_first_run_reads_authority_and_newest_page_only(stores):
    cps, store, _attr, receipts = stores
    sigs = [[{"signature": "sig2", "slot": 250_000_002, "blockTime": 1_700_000_020, "err": None},
             {"signature": "sig1", "slot": 250_000_001, "blockTime": 1_700_000_010, "err": None}]]
    rpc = _rpc(sigs, fake_tx())
    adapter = SolanaAdapter(mints=[USDC], rpc=rpc, call_sleep=0)
    stats = adapter.run(cps, store, receipts, quiet)
    rows = store.rows()
    assert stats.events_new == 2 and len(rows) == 2
    assert all(r["owner_address"] == OWNER and r["address"] == TOKEN_ACCOUNT for r in rows)
    cp = cps.get("solana", USDC.mint)
    assert cp["freeze_authority"] == AUTH
    assert cp["last_signature"] == "sig2"  # newest first in the RPC's order
    # second run: `until` is the last signature, nothing new
    rpc2 = _rpc([[]], fake_tx())
    adapter2 = SolanaAdapter(mints=[USDC], rpc=rpc2, call_sleep=0)
    stats2 = adapter2.run(cps, store, receipts, quiet)
    assert stats2.events_new == 0
    until_opts = [p[1] for m, p in rpc2.methods if m == "getSignaturesForAddress"]
    assert until_opts and until_opts[0].get("until") == "sig2"


def test_mint_without_freeze_authority_is_skipped_with_a_note(stores):
    cps, store, _attr, receipts = stores
    rpc = FakeRpc({"getAccountInfo": lambda p: {"value": {"data": {"parsed": {"info": {"freezeAuthority": None}}}}}})
    stats = SolanaAdapter(mints=[USDC], rpc=rpc, call_sleep=0).run(cps, store, receipts, quiet)
    assert stats.events_seen == 0 and any("no freeze authority" in n for n in stats.notes)


def test_backfill_token_filter_scopes_mints():
    import pytest

    from freeze_ledger.__main__ import _adapter

    assert [m.token for m in _adapter("solana", ["USDC"]).mints] == ["USDC"]
    assert len(_adapter("solana").mints) == len(SOLANA_MINTS)
    with pytest.raises(SystemExit):
        _adapter("solana", ["DAI"])
    with pytest.raises(SystemExit):
        _adapter("ethereum", ["USDC"])


def test_run_skip_drops_one_token():
    from freeze_ledger.__main__ import _run_tokens

    assert _run_tokens("solana", {"solana:USDT"}) == ["USDC"]
    assert _run_tokens("solana", set()) is None
    assert _run_tokens("tron", {"solana:USDT"}) is None
    assert _run_tokens("tron", {"tron:USDT"}) == []


# --- several freeze authorities ----------------------------------------------
OLD_AUTH = b58encode(b"\x04" * 32)
OLD_ACCOUNT = b58encode(b"\x05" * 32)


def _multisig_tx(account, authority, slot, typ="freezeAccount"):
    tx = fake_tx(slot=slot, block_time=1_600_000_000 + slot)
    ix = tx["transaction"]["message"]["instructions"][0]
    # a token-multisig authority is reported as `multisigFreezeAuthority`
    ix["parsed"] = {"type": typ, "info": {"account": account, "mint": USDC.mint,
                                          "multisigFreezeAuthority": authority, "signers": [OWNER]}}
    tx["transaction"]["message"]["accountKeys"][1] = {"pubkey": account}
    return tx


def _history_rpc(current, history, txs):
    """`history[address]` is that address's signatures, newest first;
    `before`/`until` page through it the way the RPC does."""

    def get_sigs(params):
        addr, opts = params
        sigs = history.get(addr, [])
        names = [s["signature"] for s in sigs]
        lo = names.index(opts["before"]) + 1 if opts.get("before") else 0
        hi = names.index(opts["until"]) if opts.get("until") in names else len(sigs)
        return sigs[lo:hi][: opts["limit"]]

    def get_account_info(params):
        if params[0] == USDC.mint:
            return {"value": {"data": {"parsed": {"info": {"freezeAuthority": current}}}}}
        return {"value": {"data": {"parsed": {"info": {"owner": OWNER}}}}}

    return FakeRpc({"getAccountInfo": get_account_info, "getSignaturesForAddress": get_sigs,
                    "getTransaction": lambda p: txs[p[0]]})


def _sig(name, slot):
    return {"signature": name, "slot": slot, "blockTime": 1_600_000_000 + slot, "err": None}


def test_backfill_walks_earlier_authorities_from_the_registry(stores):
    import dataclasses

    cps, store, _attr, receipts = stores
    mint = dataclasses.replace(USDC, prior_freeze_authorities=(OLD_AUTH,))
    # the current authority was already backfilled before this change
    cps.set("solana", USDC.mint, {"freeze_authority": AUTH, "authority_history": [AUTH],
                                  "last_signature": "new1", "oldest_signature": "new1", "backfill_done": True})
    history = {
        AUTH: [_sig("new1", 300)],
        OLD_AUTH: [_sig("handoff", 200), _sig("old2", 150), _sig("old1", 100), _sig("create", 50)],
    }
    txs = {
        "new1": fake_tx(slot=300),
        "handoff": fake_tx(slot=200) | {"transaction": {"message": {"accountKeys": [], "instructions": []}}},
        "old2": _multisig_tx(OLD_ACCOUNT, OLD_AUTH, 150, "thawAccount"),
        "old1": _multisig_tx(OLD_ACCOUNT, OLD_AUTH, 100),
        "create": fake_tx(slot=50) | {"transaction": {"message": {"accountKeys": [], "instructions": []}}},
    }
    rpc = _history_rpc(AUTH, history, txs)
    stats = SolanaAdapter(mints=[mint], rpc=rpc, call_sleep=0).run(cps, store, receipts, quiet, backfill=True)

    rows = sorted(store.rows(), key=lambda r: int(r["block_number"]))
    assert [(r["action"], r["address"], r["block_number"]) for r in rows] == [
        ("freeze", OLD_ACCOUNT, "100"), ("unfreeze", OLD_ACCOUNT, "150")]
    assert all(r["owner_address"] == OWNER and r["evidence_id"] for r in rows)
    cp = cps.get("solana", USDC.mint)
    assert cp["authority_history"] == [OLD_AUTH, AUTH]
    assert cp["last_signature"] == "new1"  # current authority's cursors untouched
    assert cp["authorities"][OLD_AUTH]["closed"] is True
    assert stats.cursor_from == "50"

    # a second backfill skips the closed authority and adds nothing
    rpc2 = _history_rpc(AUTH, history, txs)
    stats2 = SolanaAdapter(mints=[mint], rpc=rpc2, call_sleep=0).run(cps, store, receipts, quiet, backfill=True)
    assert stats2.events_new == 0 and len(store.rows()) == 2
    assert {p[0] for m, p in rpc2.methods if m == "getSignaturesForAddress"} == {AUTH}


def test_rotation_moves_cursors_and_closes_the_gap(stores):
    cps, store, _attr, receipts = stores
    # last run saw OLD_AUTH as the authority, through signature old1
    cps.set("solana", USDC.mint, {"freeze_authority": OLD_AUTH, "authority_history": [OLD_AUTH],
                                  "last_signature": "old1", "last_slot": 100,
                                  "oldest_signature": "old1", "oldest_slot": 100, "backfill_done": True})
    history = {AUTH: [_sig("new1", 300)], OLD_AUTH: [_sig("old2", 150), _sig("old1", 100)]}
    txs = {"new1": fake_tx(slot=300), "old2": _multisig_tx(OLD_ACCOUNT, OLD_AUTH, 150),
           "old1": _multisig_tx(OLD_ACCOUNT, OLD_AUTH, 100)}
    rpc = _history_rpc(AUTH, history, txs)  # the mint now names AUTH
    stats = SolanaAdapter(mints=[USDC], rpc=rpc, call_sleep=0).run(cps, store, receipts, quiet)

    assert any("freeze authority changed" in n for n in stats.notes)
    cp = cps.get("solana", USDC.mint)
    assert cp["freeze_authority"] == AUTH and cp["authority_history"][-2:] == [OLD_AUTH, AUTH]
    assert cp["authorities"][OLD_AUTH]["last_signature"] == "old2"
    # old1 was indexed by the earlier run, so only the gap (old2) and the new
    # authority's freeze are fetched
    fetched = [p[0] for m, p in rpc.methods if m == "getTransaction"]
    assert sorted(fetched) == ["new1", "old2"]
    assert {(r["address"], r["block_number"]) for r in store.rows()} == {(TOKEN_ACCOUNT, "300"), (OLD_ACCOUNT, "150")}


def test_pruned_endpoint_falls_back_and_unreadable_tx_keeps_authority_open(stores):
    import dataclasses

    cps, store, _attr, receipts = stores
    mint = dataclasses.replace(USDC, prior_freeze_authorities=(OLD_AUTH,))
    history = {AUTH: [], OLD_AUTH: [_sig("old1", 100)]}
    txs = {"old1": _multisig_tx(OLD_ACCOUNT, OLD_AUTH, 100)}
    full = _history_rpc(AUTH, history, txs)

    class TwoEndpoints:
        """Endpoint `full://` serves everything; `pruned://` answers empty
        pages and `null` transactions, the way a pruning node does."""

        def __init__(self, serve_tx=True):
            self.urls, self.active_url, self.calls, self.methods = ["full://", "pruned://"], "pruned://", 0, []
            self.serve_tx = serve_tx

        def call(self, method, params=None):
            self.calls += 1
            self.methods.append((self.active_url, method))
            pruned = {"getSignaturesForAddress": [], "getTransaction": None}
            if method in pruned and (self.active_url == "pruned://" or (method == "getTransaction" and not self.serve_tx)):
                return pruned[method], b"{}"
            return full.handlers[method](params), b'{"result": "full"}'

    # the full endpoint is out of transactions: the walk must not close
    rpc = TwoEndpoints(serve_tx=False)
    SolanaAdapter(mints=[mint], rpc=rpc, call_sleep=0).run(cps, store, receipts, quiet, backfill=True)
    state = cps.get("solana", USDC.mint)["authorities"][OLD_AUTH]
    assert not state.get("closed") and "last_signature" not in state and store.rows() == []

    # the full endpoint is tried first (the pruned one stays active from the
    # last call otherwise) and its answer is the one kept
    rpc = TwoEndpoints()
    SolanaAdapter(mints=[mint], rpc=rpc, call_sleep=0).run(cps, store, receipts, quiet, backfill=True)
    assert [r["block_number"] for r in store.rows()] == ["100"]
    assert cps.get("solana", USDC.mint)["authorities"][OLD_AUTH]["closed"] is True
    assert all(url == "full://" for url, m in rpc.methods if m == "getTransaction")
