"""Command line: one command per stage of the pipeline.

    python -m freeze_ledger run        [--chains ethereum,base,tron,solana] [--skip solana:USDT] [--max-calls N]
    python -m freeze_ledger backfill   --chain ethereum [--token USDT] [--max-calls N]
    python -m freeze_ledger sdn
    python -m freeze_ledger attribute  [--no-federal-register]
    python -m freeze_ledger export     [--parquet]
    python -m freeze_ledger status
    python -m freeze_ledger registry
    python -m freeze_ledger verify     (same as `python verify.py`)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone

from . import paths, registry
from .checkpoint import Checkpoints
from .receipts import Receipts, utcnow_iso
from .store import attribution_store, event_store


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"{ts} {msg}", flush=True)


def _scoped(items, tokens: list[str] | None, chain: str):
    if not tokens:
        return None
    picked = [i for i in items if i.chain == chain and i.token.upper() in tokens]
    if not picked:
        raise SystemExit(f"no {chain} entry for token(s) {','.join(tokens)}")
    return picked


def _adapter(chain: str, tokens: list[str] | None = None):
    if chain in ("ethereum", "base"):
        from .adapters.evm import EvmAdapter

        if tokens:
            raise SystemExit("--token is supported for tron and solana only")
        return EvmAdapter(chain)
    if chain == "tron":
        from .adapters.tron import TronAdapter

        return TronAdapter(contracts=_scoped(registry.TRON_CONTRACTS, tokens, chain))
    if chain == "solana":
        from .adapters.solana import SolanaAdapter

        return SolanaAdapter(mints=_scoped(registry.SOLANA_MINTS, tokens, chain))
    raise SystemExit(f"unknown chain {chain}")


def _run_tokens(chain: str, skip: set[str]) -> list[str] | None:
    """The tokens `run` indexes on `chain` after `--skip chain:TOKEN` entries."""
    items = {"tron": registry.TRON_CONTRACTS, "solana": registry.SOLANA_MINTS}.get(chain)
    if not items or not any(s.startswith(f"{chain}:") for s in skip):
        return None
    return [i.token.upper() for i in items if f"{chain}:{i.token.upper()}" not in skip]


def _write_run_log(entries: list[dict], kind: str) -> None:
    p = paths.data_dir() / "run_log.json"
    prev = json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}
    prev[kind] = {"at": utcnow_iso(), "chains": entries}
    p.write_text(json.dumps(prev, indent=2) + "\n", encoding="utf-8")


def cmd_run(args) -> int:
    paths.ensure_dirs()
    chains = [c.strip() for c in args.chains.split(",") if c.strip()]
    skip = {s.strip().lower().split(":")[0] + ":" + s.strip().split(":")[-1].upper() for s in args.skip.split(",") if ":" in s}
    cps, store, receipts = Checkpoints(), event_store(), Receipts()
    results = []
    failures = 0
    for chain in chains:
        t0 = time.time()
        tokens = _run_tokens(chain, skip)
        if tokens == []:
            log(f"[{chain}] every token skipped")
            continue
        try:
            stats = _adapter(chain, tokens).run(cps, store, receipts, log, max_calls=args.max_calls)
            d = stats.as_dict()
            d["seconds"] = round(time.time() - t0, 1)
            results.append(d)
            log(f"[{chain}] done: {stats.events_new} new of {stats.events_seen} seen, {stats.calls} calls, {d['seconds']}s")
            for n in stats.notes:
                log(f"[{chain}] note: {n}")
        except Exception as ex:  # one chain failing must not lose the others' progress
            failures += 1
            results.append({"chain": chain, "error": str(ex)})
            log(f"[{chain}] ERROR: {ex}")
    _write_run_log(results, "run")
    return 1 if failures else 0


def cmd_backfill(args) -> int:
    paths.ensure_dirs()
    cps, store, receipts = Checkpoints(), event_store(), Receipts()
    t0 = time.time()
    tokens = [t.strip().upper() for t in args.token.split(",") if t.strip()] if args.token else None
    stats = _adapter(args.chain, tokens).run(
        cps, store, receipts, log, backfill=True, max_calls=args.max_calls,
        from_cursor=args.from_block, to_cursor=args.to_block,
    )
    d = stats.as_dict()
    d["seconds"] = round(time.time() - t0, 1)
    log(f"[{args.chain}] backfill: {stats.events_new} new of {stats.events_seen} seen, {stats.calls} calls")
    for n in stats.notes:
        log(f"[{args.chain}] note: {n}")
    _write_run_log([d], "backfill")
    return 0


def cmd_sdn(args) -> int:
    paths.ensure_dirs()
    from .attribution.sdn import download_and_parse, write_sdn_csv

    if args.independent:
        from .attribution.independent import fetch_rows

        rows = fetch_rows(log=log)
        out = write_sdn_csv(rows)
        log(f"[sdn] wrote {out} ({len(rows)} rows) from the independent extract; entity/date columns empty until the XML run")
        return 0

    dest = paths.evidence_dir() / "sdn" / "sdn_advanced.xml"
    rows, sha, size = download_and_parse(dest, log=log)
    Receipts().record_hash_only("sdn_xml", f"{registry.SDN_ADVANCED_XML} {utcnow_iso()[:10]}", sha, size)
    out = write_sdn_csv(rows)
    log(f"[sdn] wrote {out} ({len(rows)} rows); raw XML kept at {dest} (gitignored)")
    return 0


def cmd_attribute(args) -> int:
    paths.ensure_dirs()
    from .attribution.join import build_attributions

    build_attributions(use_federal_register=not args.no_federal_register, log=log)
    return 0


def cmd_export(args) -> int:
    paths.ensure_dirs()
    from .export import write_latest, write_parquet

    views = write_latest()
    from .export import write_site_json

    site = write_site_json()
    log(f"[export] site.json: {site['n']} events, {len(site['entities'])} entities")
    log(f"[export] latest.json: {views['events_public']} public events, {views['currently_frozen_total']} addresses frozen now, "
        f"attribution coverage {views['attribution_coverage']}")
    if args.parquet:
        write_parquet(log=log)
    return 0


def cmd_status(args) -> int:
    cps = Checkpoints().data
    store = event_store()
    rows = store.rows()
    print(f"root: {paths.root()}")
    print(f"events: {len(rows)}  attributions: {len(attribution_store())}  receipts: {len(Receipts().index_rows())}")
    for chain in registry.all_chains():
        n = sum(1 for r in rows if r["chain"] == chain)
        print(f"  {chain:9s} rows={n:<6d} checkpoint={json.dumps(cps.get(chain, {}))[:160]}")
    return 0


def cmd_registry(args) -> int:
    print(json.dumps(registry.describe(), indent=2))
    return 0


def cmd_verify(args) -> int:
    import runpy

    sys.argv = ["verify.py"] + args.rest
    try:
        runpy.run_path(str(paths.root() / "verify.py"), run_name="__main__")
    except SystemExit as e:
        return int(e.code or 0)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="freeze-ledger", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("run", help="index forward from the checkpoints")
    p.add_argument("--chains", default=",".join(registry.all_chains()))
    p.add_argument("--max-calls", type=int, default=None, help="stop a chain after this many provider calls")
    p.add_argument("--skip", default="", help="chain:TOKEN pairs not to index, e.g. solana:USDT (until it is backfilled)")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("backfill", help="index a chain from its contract's first block (resumable)")
    p.add_argument("--chain", required=True, choices=registry.all_chains())
    p.add_argument("--token", default=None, help="tron/solana only: index just these tokens, e.g. USDC")
    p.add_argument("--max-calls", type=int, default=None)
    p.add_argument("--from-block", type=int, default=None, help="EVM only: start here instead of the deployment block")
    p.add_argument("--to-block", type=int, default=None, help="EVM only: stop here (e.g. to fill a gap below a bootstrap checkpoint)")
    p.set_defaults(fn=cmd_backfill)

    p = sub.add_parser("sdn", help="download and extract the OFAC SDN digital-currency addresses")
    p.add_argument("--independent", action="store_true", help="use 0xB10C's nightly address lists instead of sdn_advanced.xml (no entity/date)")
    p.set_defaults(fn=cmd_sdn)

    p = sub.add_parser("attribute", help="join frozen addresses to the public record and grade them")
    p.add_argument("--no-federal-register", action="store_true")
    p.set_defaults(fn=cmd_attribute)

    p = sub.add_parser("export", help="write data/latest.json (and optionally parquet)")
    p.add_argument("--parquet", action="store_true")
    p.set_defaults(fn=cmd_export)

    p = sub.add_parser("status", help="row counts and checkpoints")
    p.set_defaults(fn=cmd_status)

    p = sub.add_parser("registry", help="print every contract, mint and event signature with its source")
    p.set_defaults(fn=cmd_registry)

    p = sub.add_parser("verify", help="run the verification suite")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(fn=cmd_verify)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
