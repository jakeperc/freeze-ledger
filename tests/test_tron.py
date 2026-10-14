"""Tron address handling and the TronGrid adapter over a fake endpoint."""

import json

from freeze_ledger import normalize
from freeze_ledger.adapters.tron import TronAdapter
from freeze_ledger.registry import TRON_CONTRACTS
from tests.conftest import quiet

USDT_TRON = TRON_CONTRACTS[0]
USDT_TRON_HEX = "41a614f803b6fd780986a42c78ec9c7f77e6ded13c"


def test_base58check_round_trip_on_the_usdt_contract():
    assert normalize.tron_to_hex(USDT_TRON.address) == USDT_TRON_HEX
    assert normalize.tron_from_hex(USDT_TRON_HEX) == USDT_TRON.address
    assert normalize.tron_from_hex("0x" + USDT_TRON_HEX[2:]) == USDT_TRON.address  # EVM-style 20 bytes
    assert normalize.tron(USDT_TRON.address) == USDT_TRON.address


def test_bad_checksum_is_rejected():
    import pytest

    bad = USDT_TRON.address[:-1] + ("1" if USDT_TRON.address[-1] != "1" else "2")
    with pytest.raises(ValueError):
        normalize.tron(bad)


class FakeTron(TronAdapter):
    """Serves two pages for AddedBlackList and empty pages otherwise."""

    def __init__(self):
        super().__init__(api_key="test", page_sleep=0)
        self.requests = []

    def fetch_page(self, contract, event_name, min_ts, fingerprint):
        self.requests.append((event_name, min_ts, fingerprint))
        self.calls += 1
        if event_name == "AddedBlackList" and fingerprint is None:
            obj = {
                "data": [
                    {
                        "block_number": 60_000_000,
                        "block_timestamp": 1_700_000_000_000,
                        "contract_address": contract,
                        "event_index": 0,
                        "event_name": "AddedBlackList",
                        "result": {"_user": "0x" + USDT_TRON_HEX[2:]},
                        "transaction_id": "a" * 64,
                    },
                    {
                        "block_number": 60_000_001,
                        "block_timestamp": 1_700_000_003_000,
                        "contract_address": contract,
                        "event_index": 2,
                        "event_name": "AddedBlackList",
                        "result": {"_user": "TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh"},
                        "transaction_id": "b" * 64,
                    },
                ],
                "success": True,
                "meta": {"fingerprint": "fp1", "links": {"next": "https://example/next"}, "page_size": 200},
            }
        elif event_name == "AddedBlackList" and fingerprint == "fp1":
            obj = {
                "data": [
                    {
                        "block_number": 60_000_002,
                        "block_timestamp": 1_700_000_006_000,
                        "contract_address": contract,
                        "event_index": 1,
                        "event_name": "AddedBlackList",
                        "result": {"_user": "TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh"},
                        "transaction_id": "c" * 64,
                    }
                ],
                "success": True,
                "meta": {"page_size": 200},
            }
        elif event_name == "DestroyedBlackFunds" and fingerprint is None:
            obj = {
                "data": [
                    {
                        "block_number": 60_000_003,
                        "block_timestamp": 1_700_000_009_000,
                        "contract_address": contract,
                        "event_index": 0,
                        "event_name": "DestroyedBlackFunds",
                        "result": {"_blackListedUser": "TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh", "_balance": "2500000"},
                        "transaction_id": "d" * 64,
                    }
                ],
                "success": True,
                "meta": {"page_size": 200},
            }
        else:
            obj = {"data": [], "success": True, "meta": {"page_size": 200}}
        raw = json.dumps(obj).encode()
        return obj, raw, f"fake://tron/{event_name}/{fingerprint}"


def test_tron_adapter_paginates_normalizes_and_checkpoints(stores):
    cps, store, _attr, receipts = stores
    adapter = FakeTron()
    stats = adapter.run(cps, store, receipts, quiet, backfill=True)
    rows = store.rows()
    assert stats.events_new == 4 and len(rows) == 4
    # the hex address came back as the contract's own address -> flagged internal
    internal = next(r for r in rows if r["tx_hash"] == "a" * 64)
    assert internal["address"] == USDT_TRON.address and internal["issuer_internal"] == "true"
    destroy = next(r for r in rows if r["action"] == "destroy")
    assert destroy["amount"] == "2.500000"
    assert all(r["address"].startswith("T") for r in rows)
    # pagination followed the fingerprint once, then stopped
    added = [r for r in adapter.requests if r[0] == "AddedBlackList"]
    assert [r[2] for r in added] == [None, "fp1"]
    # checkpoint holds the newest timestamp per event
    last = cps.get("tron", "last_ts")
    assert last[f"{USDT_TRON.address}:AddedBlackList"] == 1_700_000_006_000
    # incremental run re-reads from the margin and adds nothing
    stats2 = adapter.run(cps, store, receipts, quiet)
    assert stats2.events_new == 0
    assert any(r[1] <= 1_700_000_006_000 for r in adapter.requests[-3:])
