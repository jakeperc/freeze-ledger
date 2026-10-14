"""Store de-duplication, receipts, derived views, and the verification suite
catching an injected error (the test the scope asks for on day one)."""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from freeze_ledger import paths
from freeze_ledger.export import compute_views, currently_frozen, write_latest
from freeze_ledger.receipts import Receipts
from freeze_ledger.store import event_store

ROOT = Path(__file__).resolve().parent.parent


def _row(eid, chain="ethereum", action="freeze", address="0x" + "1" * 40, t="2024-01-15T00:00:00Z", internal="",
         amount="", token="USDT", issuer="tether"):
    tx, idx = eid.split(":")[1], eid.split(":")[2]
    return {
        "event_id": eid, "chain": chain, "issuer": issuer, "token": token, "action": action, "address": address,
        "owner_address": "", "amount": amount, "block_number": "100", "block_time": t, "tx_hash": tx,
        "log_index": idx, "issuer_internal": internal, "evidence_id": "ev_x", "indexed_at": t,
    }


def test_store_dedupes_by_event_id(repo):
    store = event_store()
    assert store.append([_row("ethereum:0xaa:1"), _row("ethereum:0xaa:1")]) == 1
    assert store.append([_row("ethereum:0xaa:1"), _row("ethereum:0xab:0")]) == 1
    assert len(event_store()) == 2  # reloads keys from disk


def test_receipts_dedupe_identical_responses_and_hash(repo):
    r = Receipts()
    a = r.record("rpc_log", "fake://a", b'{"result": [1]}')
    b = r.record("rpc_log", "fake://b", b'{"result": [1]}')
    c = r.record("rpc_log", "fake://c", b'{"result": [2]}')
    assert a == b != c
    rows = r.index_rows()
    assert len(rows) == 2
    raw = r.find_raw(rows[0]["sha256"]).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == rows[0]["sha256"]


def test_currently_frozen_follows_last_action_and_views_exclude_internal():
    ev = [
        _row("ethereum:0xa:0", action="freeze", t="2024-01-01T00:00:00Z"),
        _row("ethereum:0xb:0", action="unfreeze", t="2024-02-01T00:00:00Z"),
        _row("ethereum:0xc:0", action="freeze", t="2024-03-01T00:00:00Z"),
        _row("ethereum:0xd:0", action="freeze", address="0x" + "2" * 40, t="2024-03-05T00:00:00Z"),
        _row("ethereum:0xe:0", action="destroy", address="0x" + "2" * 40, amount="10.000000", t="2024-03-06T00:00:00Z"),
        _row("ethereum:0xf:0", action="freeze", address="0xdac17f958d2ee523a2206206994597c13d831ec7", internal="true"),
        _row("tron:aa:0", chain="tron", action="freeze", address="TJmmqjb1DK9TTZbQXzRQ2AuA94z4gKAPFh", t="2024-04-01T00:00:00Z"),
    ]
    state = currently_frozen([e for e in ev if e["issuer_internal"] != "true"])
    assert state[("ethereum", "USDT", "0x" + "1" * 40)] is True
    assert state[("ethereum", "USDT", "0x" + "2" * 40)] is True
    views = compute_views(ev, [])
    assert views["events_public"] == 6 and views["events_issuer_internal"] == 1
    assert views["currently_frozen"] == {"ethereum": {"USDT": 2}, "tron": {"USDT": 1}}
    assert views["destroyed_usdt_by_chain"] == {"ethereum": "10.000000"}
    assert [m["month"] for m in views["monthly_freezes"]] == ["2024-01", "2024-03", "2024-04"]
    assert views["attribution_coverage"]["frozen_addresses"] == 3
    assert views["attribution_coverage"]["unattributed"] == 3


def _run_verify(root: Path, *args) -> tuple[int, str]:
    env = {"FL_ROOT": str(root), "PATH": "/usr/bin:/bin", "PYTHONPATH": str(ROOT)}
    p = subprocess.run([sys.executable, str(ROOT / "verify.py"), "--offline", *args], capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def test_verify_passes_clean_data_and_catches_an_injected_edit(repo):
    receipts = Receipts()
    raw = json.dumps({"result": [{"transactionHash": "0xaa", "logIndex": "0x1"}]}).encode()
    eid = receipts.record("rpc_log", "fake://logs", raw)
    store = event_store()
    row = _row("ethereum:0xaa:1")
    row["evidence_id"] = eid
    store.append([row])
    write_latest()

    code, out = _run_verify(repo)
    assert code == 0, out
    assert "PASSED" in out

    # inject an error: edit the stored address so the row no longer matches
    # its receipt's canonical form and the published views
    p = paths.events_csv()
    text = p.read_text(encoding="utf-8").replace("0x" + "1" * 40, "0x" + "3" * 40)
    p.write_text(text, encoding="utf-8")
    code, out = _run_verify(repo)
    assert code == 1
    assert "FAIL" in out and "views" in out

    # and a tampered receipt is caught too
    p.write_text(text.replace("0x" + "3" * 40, "0x" + "1" * 40), encoding="utf-8")
    write_latest()
    rawfile = receipts.find_raw(receipts.index_rows()[0]["sha256"])
    rawfile.write_bytes(rawfile.read_bytes() + b" ")
    code, out = _run_verify(repo)
    assert code == 1 and "receipts.hash" in out
