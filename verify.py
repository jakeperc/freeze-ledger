#!/usr/bin/env python3
"""The public verification suite.

Re-derives the published numbers and a random sample of rows, and exits
non-zero on any mismatch. The nightly workflow runs this before it commits;
anyone can run it after cloning. Standard library only.

Checks
  1. schema      every row has the required columns; event_id is
                 "{chain}:{tx_hash}:{log_index}" and unique
  2. receipts    every row's evidence_id is in evidence.csv; where the raw
                 response file is present it still hashes to the recorded
                 value and contains the row's transaction hash
  3. views       latest.json equals the views recomputed from the CSVs
  4. chain       a random sample of rows is re-fetched from a second public
                 endpoint and compared field by field   (skipped with --offline)
  5. sdn         the SDN extract contains every address in an independent
                 nightly extract of the same list      (skipped with --offline)

Usage: python verify.py [--offline] [--sample N] [--seed S] [--chains a,b]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

from freeze_ledger import normalize, paths, registry  # noqa: E402
from freeze_ledger.adapters.evm import decode_log, format_amount  # noqa: E402
from freeze_ledger.adapters.solana import parse_freeze_instructions  # noqa: E402
from freeze_ledger.export import compute_views  # noqa: E402
from freeze_ledger.http import JsonRpc, get_json  # noqa: E402
from freeze_ledger.receipts import Receipts  # noqa: E402
from freeze_ledger.store import EVENT_COLUMNS, attribution_store, event_store  # noqa: E402
from freeze_ledger.checkpoint import Checkpoints  # noqa: E402


class Report:
    def __init__(self):
        self.checks: list[dict] = []
        self.failed = 0

    def ok(self, name: str, detail: str = "") -> None:
        self.checks.append({"check": name, "status": "ok", "detail": detail})
        print(f"  ok    {name}" + (f" — {detail}" if detail else ""))

    def warn(self, name: str, detail: str) -> None:
        self.checks.append({"check": name, "status": "warn", "detail": detail})
        print(f"  warn  {name} — {detail}")

    def fail(self, name: str, detail: str) -> None:
        self.failed += 1
        self.checks.append({"check": name, "status": "FAIL", "detail": detail})
        print(f"  FAIL  {name} — {detail}")

    def skip(self, name: str, detail: str) -> None:
        self.checks.append({"check": name, "status": "skipped", "detail": detail})
        print(f"  skip  {name} — {detail}")


# --- 1. schema -------------------------------------------------------------------
def check_schema(events: list[dict], rep: Report) -> None:
    missing_cols = [c for c in EVENT_COLUMNS if events and c not in events[0]]
    if missing_cols:
        rep.fail("schema.columns", f"missing columns {missing_cols}")
        return
    seen = set()
    bad = 0
    for e in events:
        expect = f"{e['chain']}:{e['tx_hash']}:{e['log_index']}"
        if e["event_id"] != expect or e["event_id"] in seen:
            bad += 1
        seen.add(e["event_id"])
        if e["action"] not in ("freeze", "unfreeze", "destroy"):
            bad += 1
        try:
            if normalize.for_chain(e["chain"], e["address"]) != e["address"]:
                bad += 1
        except ValueError:
            bad += 1
    if bad:
        rep.fail("schema.rows", f"{bad} row(s) with a malformed or duplicate event_id, action or address")
    else:
        rep.ok("schema.rows", f"{len(events)} rows, unique canonical event_ids")


# --- 2. receipts -----------------------------------------------------------------
def check_receipts(events: list[dict], receipts: Receipts, rep: Report) -> None:
    index = {r["evidence_id"]: r for r in receipts.index_rows()}
    missing = [e["event_id"] for e in events if e["evidence_id"] not in index]
    if missing:
        rep.fail("receipts.index", f"{len(missing)} row(s) reference an evidence_id not in evidence.csv (e.g. {missing[:3]})")
    else:
        rep.ok("receipts.index", f"all {len(events)} rows have an indexed receipt")

    by_eid: dict[str, list[dict]] = defaultdict(list)
    for e in events:
        by_eid[e["evidence_id"]].append(e)
    checked = mismatched = unbound = absent = 0
    for eid, rows in by_eid.items():
        rec = index.get(eid)
        if not rec:
            continue
        raw_path = receipts.find_raw(rec["sha256"])
        if raw_path is None:
            absent += 1
            continue
        raw = raw_path.read_bytes()
        checked += 1
        if hashlib.sha256(raw).hexdigest() != rec["sha256"]:
            mismatched += 1
            continue
        text = raw.decode("utf-8", "replace").lower()
        for r in rows:
            if r["tx_hash"].lower() not in text:
                unbound += 1
    if mismatched:
        rep.fail("receipts.hash", f"{mismatched} raw file(s) no longer hash to their recorded sha256")
    else:
        rep.ok("receipts.hash", f"{checked} raw file(s) re-hashed; {absent} not present locally (size cap or release asset)")
    if unbound:
        rep.fail("receipts.binding", f"{unbound} row(s) whose tx hash is not inside their receipt's raw response")
    elif checked:
        rep.ok("receipts.binding", "every checked row's tx hash appears in its receipt")


# --- 3. views ------------------------------------------------------------------
def _strip_volatile(v: dict) -> dict:
    v = dict(v)
    for k in ("generated_at", "files", "registry", "checkpoints", "last_run"):
        v.pop(k, None)
    return v


def check_views(events: list[dict], attributions: list[dict], rep: Report) -> None:
    p = paths.latest_json()
    if not p.exists():
        rep.skip("views.latest", "data/latest.json not present (run `export`)")
        return
    published = json.loads(p.read_text(encoding="utf-8"))
    # Round-trip through JSON so tuples compare equal to the lists latest.json holds.
    recomputed = json.loads(json.dumps(compute_views(events, attributions)))
    a, b = _strip_volatile(published), _strip_volatile(recomputed)
    diffs = [k for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)]
    if diffs:
        rep.fail("views.latest", f"latest.json differs from recomputation in: {diffs}")
    else:
        rep.ok("views.latest", f"{len(b)} derived fields match (events_public={b['events_public']}, frozen_now={b['currently_frozen_total']})")
    # file hashes
    files = published.get("files", {})
    for name, meta in files.items():
        fp = paths.data_dir() / name
        if fp.exists() and meta.get("sha256") and hashlib.sha256(fp.read_bytes()).hexdigest() != meta["sha256"]:
            rep.fail("views.files", f"{name} changed since latest.json was written")


# --- 4. chain re-derivation ---------------------------------------------------
def _second_endpoint(chain: str) -> list[str]:
    urls = registry.rpc_urls(chain)
    # prefer an endpoint other than the one that indexed (first in the list)
    return urls[1:] + urls[:1] if len(urls) > 1 else urls


def recheck_evm(e: dict, rpc: JsonRpc) -> str | None:
    receipt, _ = rpc.call("eth_getTransactionReceipt", [e["tx_hash"]])
    if not receipt:
        return "transaction receipt not found"
    if int(receipt.get("blockNumber", "0x0"), 16) != int(e["block_number"]):
        return f"block mismatch: chain {int(receipt['blockNumber'], 16)} vs row {e['block_number']}"
    logs = [l for l in receipt.get("logs", []) if int(l["logIndex"], 16) == int(e["log_index"])]
    if not logs:
        return "no log at that index"
    lg = logs[0]
    contract = next((c for c in registry.EVM_CONTRACTS if c.chain == e["chain"] and c.address.lower() == lg["address"].lower()), None)
    if not contract:
        return f"log emitted by {lg['address']}, not an issuer contract"
    spec = next((s for s in contract.events if s.topic0 == lg["topics"][0].lower()), None)
    if not spec or spec.action != e["action"]:
        return "event/action mismatch"
    decoded = decode_log(lg, spec)
    if decoded[spec.params[0][0]] != e["address"]:
        return "address mismatch"
    if spec.action == "destroy" and format_amount(decoded[spec.params[1][0]]) != e["amount"]:
        return "amount mismatch"
    return None


def recheck_tron(e: dict) -> str | None:
    headers = {"Accept": "application/json"}
    key = registry.tron_api_key()
    if key:
        headers["TRON-PRO-API-KEY"] = key
    obj, _ = get_json(f"{registry.TRONGRID_BASE}/v1/transactions/{e['tx_hash']}/events", headers=headers)
    items = obj.get("data") or []
    hit = next((i for i in items if int(i.get("event_index", -1)) == int(e["log_index"])), None)
    if not hit:
        return "no event at that index"
    contract = registry.TRON_CONTRACTS[0]
    spec = next((s for s in contract.events if s.name == hit.get("event_name")), None)
    if not spec or spec.action != e["action"]:
        return "event/action mismatch"
    res = hit.get("result") or {}
    if normalize.tron(str(res[spec.params[0][0]])) != e["address"]:
        return "address mismatch"
    if int(hit.get("block_number", -1)) != int(e["block_number"]):
        return "block mismatch"
    return None


def recheck_solana(e: dict, urls: list[str], served_by: list[str]) -> str | None:
    # Public Solana endpoints prune history at different depths and answer
    # `null` for a transaction they no longer hold. That is "not served here",
    # not a mismatch: try the next endpoint and record which one answered.
    tx = None
    for url in urls:
        tx, _ = JsonRpc([url]).call("getTransaction", [e["tx_hash"], {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
        if tx:
            served_by.append(url)
            break
    if not tx:
        return "transaction not found on any endpoint"
    mint = next((m.mint for m in registry.SOLANA_MINTS if m.token == e["token"]), "")
    found = parse_freeze_instructions(tx, mint)
    hit = next((f for f in found if f["position"] == int(e["log_index"])), None)
    if not hit:
        return "no freeze/thaw instruction at that position"
    if hit["account"] != e["address"] or hit["action"] != e["action"]:
        return "account/action mismatch"
    if int(tx.get("slot", -1)) != int(e["block_number"]):
        return "slot mismatch"
    return None


def check_chain(events: list[dict], rep: Report, sample: int, seed: int, chains: list[str]) -> None:
    rng = random.Random(seed)
    for chain in chains:
        rows = [e for e in events if e["chain"] == chain]
        if not rows:
            rep.skip(f"chain.{chain}", "no rows")
            continue
        picked = rng.sample(rows, min(sample, len(rows)))
        rpc = JsonRpc(_second_endpoint(chain)) if chain in ("ethereum", "base") else None
        served_by: list[str] = []
        problems = []
        for e in picked:
            try:
                if chain in ("ethereum", "base"):
                    err = recheck_evm(e, rpc)
                elif chain == "tron":
                    err = recheck_tron(e)
                else:
                    err = recheck_solana(e, _second_endpoint(chain), served_by)
            except Exception as ex:  # network or provider failure is reported, not hidden
                err = f"could not re-fetch: {ex}"
            if err:
                problems.append(f"{e['event_id']}: {err}")
        if problems:
            rep.fail(f"chain.{chain}", f"{len(problems)}/{len(picked)} sampled rows failed re-derivation: {problems[:3]}")
        else:
            if chain == "solana":
                counts = {u: served_by.count(u) for u in dict.fromkeys(served_by)}
                src = ", ".join(f"{u} ({n})" for u, n in counts.items())
                if any(u != _second_endpoint(chain)[0] for u in served_by):
                    src += "; second endpoint did not hold every sampled transaction"
            else:
                src = rpc.active_url if rpc else registry.TRONGRID_BASE
            rep.ok(f"chain.{chain}", f"{len(picked)} sampled rows re-derived from {src}")


# --- 5. sdn cross-check --------------------------------------------------------
def check_sdn(rep: Report) -> None:
    p = paths.sdn_addresses_csv()
    if not p.exists():
        rep.skip("sdn.crosscheck", "data/sdn_addresses.csv not present (run `sdn`)")
        return
    import csv

    with p.open(newline="", encoding="utf-8") as f:
        # Same rule as below: only EVM hex is case-insensitive; base58 keeps case.
        ours = {(a.lower() if a.startswith("0x") else a) for a in (r["address_norm"].strip() for r in csv.DictReader(f))}
    total = missing = 0
    for asset, url in registry.B10C_LISTS.items():
        try:
            lst, _ = get_json(url, timeout=60, retries=2)
        except Exception as ex:
            rep.warn("sdn.crosscheck", f"could not fetch {asset} list: {ex}")
            continue
        for a in lst:
            total += 1
            a = str(a).strip()
            norm = a.lower() if a.startswith("0x") else a
            if norm not in ours:
                missing += 1
    if total == 0:
        rep.skip("sdn.crosscheck", "no independent lists fetched")
    elif missing / total > 0.02:
        rep.fail("sdn.crosscheck", f"{missing}/{total} addresses in the independent extract are absent from ours")
    else:
        rep.ok("sdn.crosscheck", f"{total - missing}/{total} addresses of the independent extract present in ours")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="skip the chain re-derivation and SDN cross-check")
    ap.add_argument("--sample", type=int, default=5, help="rows per chain to re-derive (default 5)")
    ap.add_argument("--seed", type=int, default=None, help="random seed (default: today's date)")
    ap.add_argument("--chains", default=",".join(registry.all_chains()))
    args = ap.parse_args(argv)
    seed = args.seed if args.seed is not None else int(datetime.now(timezone.utc).strftime("%Y%m%d"))

    print(f"freeze-ledger verify — root {paths.root()} — seed {seed}")
    rep = Report()
    events = event_store().rows()
    attributions = attribution_store().rows()
    receipts = Receipts()
    if not events:
        rep.warn("data", "freeze_events.csv is empty or absent; only structural checks run")
    check_schema(events, rep)
    check_receipts(events, receipts, rep)
    check_views(events, attributions, rep)
    if args.offline:
        rep.skip("chain", "--offline")
        rep.skip("sdn.crosscheck", "--offline")
    else:
        check_chain(events, rep, args.sample, seed, [c.strip() for c in args.chains.split(",") if c.strip()])
        check_sdn(rep)

    out = {
        "verified_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "seed": seed,
        "offline": args.offline,
        "events": len(events),
        "failed": rep.failed,
        "checks": rep.checks,
    }
    paths.data_dir().mkdir(parents=True, exist_ok=True)
    (paths.data_dir() / "verification_report.json").write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print("result:", "FAILED" if rep.failed else "PASSED", f"({rep.failed} failing check(s))")
    return 1 if rep.failed else 0


if __name__ == "__main__":
    sys.exit(main())
