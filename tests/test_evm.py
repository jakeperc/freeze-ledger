"""EVM decoding against synthetic logs that follow the two ABIs exactly, and
an end-to-end indexer run over a fake provider.

The logs here are constructed, not copied from chain: they exercise the
exact encoding (Tether: address in `data`; Circle: address in `topics[1]`)
and the ledger's bookkeeping. Real-chain rows are checked by verify.py.
"""

from freeze_ledger import registry
from freeze_ledger.adapters.evm import EvmAdapter, decode_log, format_amount
from tests.conftest import FakeRpc, quiet

USDT = next(c for c in registry.EVM_CONTRACTS if c.token == "USDT" and c.chain == "ethereum")
USDC = next(c for c in registry.EVM_CONTRACTS if c.token == "USDC" and c.chain == "ethereum")
ADDED, REMOVED, DESTROYED = USDT.events
BLACKLISTED, UNBLACKLISTED = USDC.events

VICTIM = "0x1111111111111111111111111111111111111111"


def word_addr(a: str) -> str:
    return "0" * 24 + a[2:].lower()


def word_uint(n: int) -> str:
    return f"{n:064x}"


def tether_log(spec, address, amount=None, block=19_000_000, idx=7, tx="0x" + "ab" * 32):
    data = "0x" + word_addr(address) + (word_uint(amount) if amount is not None else "")
    return {
        "address": USDT.address.lower(),
        "topics": [spec.topic0],
        "data": data,
        "blockNumber": hex(block),
        "transactionHash": tx,
        "logIndex": hex(idx),
        "removed": False,
    }


def circle_log(spec, address, block=19_000_001, idx=3, tx="0x" + "cd" * 32):
    return {
        "address": USDC.address.lower(),
        "topics": [spec.topic0, "0x" + word_addr(address)],
        "data": "0x",
        "blockNumber": hex(block),
        "transactionHash": tx,
        "logIndex": hex(idx),
        "removed": False,
    }


def test_decode_tether_added_blacklist():
    out = decode_log(tether_log(ADDED, VICTIM), ADDED)
    assert out == {"_user": VICTIM}


def test_decode_tether_destroyed_funds_with_amount():
    out = decode_log(tether_log(DESTROYED, VICTIM, amount=1_234_567_890), DESTROYED)
    assert out["_blackListedUser"] == VICTIM
    assert format_amount(out["_balance"]) == "1234.567890"


def test_decode_circle_blacklisted_indexed_param():
    out = decode_log(circle_log(BLACKLISTED, VICTIM), BLACKLISTED)
    assert out == {"_account": VICTIM}


def _fake_chain(logs_by_range):
    """logs_by_range: list of (from, to, [logs]) answered by eth_getLogs when
    the queried range overlaps."""

    def get_logs(params):
        f, t = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
        out = []
        for lg in logs_by_range:
            b = int(lg["blockNumber"], 16)
            if f <= b <= t:
                out.append(lg)
        return out

    return FakeRpc(
        {
            "eth_blockNumber": lambda p: hex(19_000_100),
            "eth_getLogs": get_logs,
            "eth_getBlockByNumber": lambda p: {"timestamp": hex(1_700_000_000 + int(p[0], 16) - 19_000_000)},
            "eth_getCode": lambda p: "0x6001" if int(p[1], 16) >= 18_999_990 else "0x",
        }
    )


def test_run_indexes_decodes_dedupes_and_checkpoints(stores):
    cps, store, _attr, receipts = stores
    logs = [
        tether_log(ADDED, VICTIM),
        tether_log(DESTROYED, VICTIM, amount=5_000_000, block=19_000_050, idx=2, tx="0x" + "ef" * 32),
        circle_log(BLACKLISTED, VICTIM),
        # issuer blacklists its own contract: kept, flagged, excluded from headline counts
        tether_log(ADDED, USDT.address, block=19_000_060, idx=1, tx="0x" + "11" * 32),
    ]
    rpc = _fake_chain(logs)
    adapter = EvmAdapter("ethereum", rpc=rpc, chunk=1000)

    stats = adapter.run(cps, store, receipts, quiet, from_cursor=19_000_000, to_cursor=19_000_088)
    assert stats.events_seen == 4 and stats.events_new == 4
    rows = store.rows()
    assert {r["action"] for r in rows} == {"freeze", "destroy"}
    destroy = next(r for r in rows if r["action"] == "destroy")
    assert destroy["amount"] == "5.000000" and destroy["token"] == "USDT"
    usdc = next(r for r in rows if r["token"] == "USDC")
    assert usdc["issuer"] == "circle" and usdc["address"] == VICTIM
    internal = next(r for r in rows if r["address"] == USDT.address.lower())
    assert internal["issuer_internal"] == "true"
    # every row carries a receipt that exists and hashes correctly
    index = {r["evidence_id"]: r for r in receipts.index_rows()}
    assert all(r["evidence_id"] in index for r in rows)
    assert cps.get("ethereum", "last_block") == 19_000_088
    # event ids are canonical
    assert all(r["event_id"] == f"ethereum:{r['tx_hash']}:{r['log_index']}" for r in rows)

    # a second run over the same range re-reads the reorg margin and writes nothing new
    stats2 = adapter.run(cps, store, receipts, quiet)
    assert stats2.events_new == 0
    assert len(store.rows()) == 4


def test_backfill_locates_deployment_block_by_binary_search(stores):
    cps, store, _attr, receipts = stores
    rpc = _fake_chain([])
    adapter = EvmAdapter("ethereum", contracts=[USDT], rpc=rpc, chunk=100)
    stats = adapter.run(cps, store, receipts, quiet, backfill=True, to_cursor=19_000_000)
    assert cps.get("ethereum", "deployment_block")[USDT.address.lower()] == 18_999_990
    assert stats.cursor_from == "18999990"


def test_adaptive_chunk_shrinks_on_provider_range_error(stores):
    from freeze_ledger.http import RpcError

    cps, store, _attr, receipts = stores
    seen_ranges = []

    def get_logs(params):
        f, t = int(params[0]["fromBlock"], 16), int(params[0]["toBlock"], 16)
        if t - f + 1 > 250:
            raise RpcError(-32005, "query returned more than 10000 results", "eth_getLogs")
        seen_ranges.append((f, t))
        return []

    rpc = FakeRpc({"eth_blockNumber": lambda p: hex(20_000), "eth_getLogs": get_logs,
                   "eth_getBlockByNumber": lambda p: {"timestamp": "0x1"}})
    adapter = EvmAdapter("ethereum", rpc=rpc, chunk=1000, min_chunk=50)
    adapter.run(cps, store, receipts, quiet, from_cursor=0, to_cursor=999)
    assert seen_ranges and all(t - f + 1 <= 250 for f, t in seen_ranges)
    assert seen_ranges[0][0] == 0 and seen_ranges[-1][1] == 999
