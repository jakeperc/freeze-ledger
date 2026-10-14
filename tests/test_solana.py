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
