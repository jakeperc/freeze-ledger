"""Derived views, computed from the three tables and never hand-edited.

`latest.json` is what the site reads. The verification suite recomputes
everything in this module from the CSVs and refuses to commit if the file
on disk disagrees.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

from . import paths, registry
from .checkpoint import Checkpoints
from .store import attribution_store, event_store

CONF_ORDER = {"high": 3, "moderate": 2, "low": 1}


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else ""


def currently_frozen(events: list[dict]) -> dict[tuple[str, str, str], bool]:
    """(chain, token, address) -> frozen now, from the last action in order."""
    ordered = sorted(events, key=lambda e: (e["chain"], e["token"], e["address"], e["block_time"], int(e["block_number"]), int(e["log_index"])))
    state: dict[tuple[str, str, str], bool] = {}
    for e in ordered:
        k = (e["chain"], e["token"], e["address"])
        if e["action"] in ("freeze", "destroy"):
            state[k] = True
        elif e["action"] == "unfreeze":
            state[k] = False
    return state


def compute_views(events: list[dict], attributions: list[dict], checkpoints: dict | None = None,
                  run_log: dict | None = None) -> dict:
    public = [e for e in events if e.get("issuer_internal") != "true"]
    internal = [e for e in events if e.get("issuer_internal") == "true"]

    by_chain_action: dict[str, Counter] = defaultdict(Counter)
    by_token_action: dict[str, Counter] = defaultdict(Counter)
    for e in public:
        by_chain_action[e["chain"]][e["action"]] += 1
        by_token_action[e["token"]][e["action"]] += 1

    frozen_state = currently_frozen(public)
    frozen_now: dict[str, Counter] = defaultdict(Counter)
    for (chain, token, _addr), is_frozen in frozen_state.items():
        if is_frozen:
            frozen_now[chain][token] += 1

    destroyed: dict[str, Decimal] = defaultdict(Decimal)
    for e in public:
        if e["action"] == "destroy" and e.get("amount"):
            destroyed[e["chain"]] += Decimal(e["amount"])

    monthly: dict[str, Counter] = defaultdict(Counter)  # "YYYY-MM" -> chain -> freezes
    for e in public:
        if e["action"] == "freeze":
            monthly[e["block_time"][:7]][e["chain"]] += 1
    months = sorted(monthly)
    chains = registry.all_chains()
    monthly_series = [{"month": m, **{c: monthly[m].get(c, 0) for c in chains}} for m in months]

    coverage: dict[str, dict] = {}
    frozen_addresses = {(e["chain"], e["address"]) for e in public if e["action"] in ("freeze", "destroy")}
    best: dict[tuple[str, str], str] = {}
    programs: Counter = Counter()
    for a in attributions:
        if a.get("superseded_by"):
            continue
        k = (a["chain"], a["address"])
        if k not in frozen_addresses:
            continue
        cur = best.get(k)
        if cur is None or CONF_ORDER[a["confidence"]] > CONF_ORDER[cur]:
            best[k] = a["confidence"]
        for p in (a.get("program") or "").split(";"):
            if p:
                programs[p] += 1
    conf_counts = Counter(best.values())
    n_frozen = len(frozen_addresses)
    coverage = {
        "frozen_addresses": n_frozen,
        "high": conf_counts.get("high", 0),
        "moderate": conf_counts.get("moderate", 0),
        "low": conf_counts.get("low", 0),
        "unattributed": n_frozen - len(best),
        "unattributed_share": round((n_frozen - len(best)) / n_frozen, 4) if n_frozen else None,
    }
    per_chain_cov: dict[str, dict] = {}
    for c in chains:
        addrs = {k for k in frozen_addresses if k[0] == c}
        attributed = {k for k in best if k[0] == c}
        per_chain_cov[c] = {
            "frozen_addresses": len(addrs),
            "attributed": len(attributed),
            "unattributed": len(addrs) - len(attributed),
        }

    span: dict[str, dict] = {}
    for c in chains:
        times = [e["block_time"] for e in events if e["chain"] == c]
        span[c] = {"first": min(times) if times else None, "last": max(times) if times else None, "events": len(times)}
        detail: dict[str, dict] = {}
        for e in events:
            if e["chain"] != c:
                continue
            k = f"{e['token']}:{e['action']}"
            d = detail.setdefault(k, {"first": e["block_time"], "last": e["block_time"], "events": 0})
            d["first"] = min(d["first"], e["block_time"])
            d["last"] = max(d["last"], e["block_time"])
            d["events"] += 1
        span[c]["detail"] = detail

    # --- issuer behaviour --------------------------------------------------------
    by_issuer: dict[str, dict] = {}
    for issuer in ("tether", "circle"):
        ev = [e for e in public if e["issuer"] == issuer]
        if not ev:
            continue
        frozen_addrs = {(e["chain"], e["address"]) for e in ev if e["action"] in ("freeze", "destroy")}
        released = {(e["chain"], e["address"]) for e in ev if e["action"] == "unfreeze"}
        token = "USDT" if issuer == "tether" else "USDC"
        now_frozen = sum(1 for (c, t, a), f in frozen_state.items() if f and t == token)
        sdn_hits = {k for k in best if k in frozen_addrs}
        by_issuer[issuer] = {
            "events": len(ev),
            "freezes": sum(1 for e in ev if e["action"] == "freeze"),
            "unfreezes": sum(1 for e in ev if e["action"] == "unfreeze"),
            "destroys": sum(1 for e in ev if e["action"] == "destroy"),
            "frozen_addresses": len(frozen_addrs),
            "released_addresses": len(released),
            "currently_frozen": now_frozen,
            "attributed_addresses": len(sdn_hits),
            "destroyed_total": f"{sum(Decimal(e['amount']) for e in ev if e['action'] == 'destroy' and e.get('amount')):.6f}",
        }

    # --- cross-chain ----------------------------------------------------------------
    chains_per_addr: dict[str, set] = defaultdict(set)
    for (c, a) in frozen_addresses:
        chains_per_addr[a].add(c)
    multi = {a: sorted(cs) for a, cs in chains_per_addr.items() if len(cs) > 1}
    pair_counts: Counter = Counter()
    for cs in multi.values():
        pair_counts["+".join(cs)] += 1

    # --- lags ------------------------------------------------------------------------
    def _days(a: str, b: str) -> float:
        from datetime import datetime as _dt

        return (_dt.fromisoformat(b.replace("Z", "+00:00")) - _dt.fromisoformat(a.replace("Z", "+00:00"))).total_seconds() / 86400

    first_freeze: dict[tuple, str] = {}
    for e in sorted(public, key=lambda e: e["block_time"]):
        k = (e["chain"], e["token"], e["address"])
        if e["action"] == "freeze" and k not in first_freeze:
            first_freeze[k] = e["block_time"]
    destroy_lags, release_lags = [], []
    for e in public:
        k = (e["chain"], e["token"], e["address"])
        if k in first_freeze and e["block_time"] >= first_freeze[k]:
            if e["action"] == "destroy":
                destroy_lags.append(_days(first_freeze[k], e["block_time"]))
            elif e["action"] == "unfreeze":
                release_lags.append(_days(first_freeze[k], e["block_time"]))

    def _quantiles(xs: list[float]) -> dict | None:
        if not xs:
            return None
        xs = sorted(xs)
        q = lambda p: xs[min(len(xs) - 1, int(p * (len(xs) - 1)))]
        return {"n": len(xs), "p25": round(q(0.25), 1), "median": round(q(0.5), 1), "p75": round(q(0.75), 1), "max": round(xs[-1], 1)}

    # --- SDN screening per issuer and chain: of the SDN EVM addresses frozen anywhere, who froze them where
    sdn_addr_chain = defaultdict(set)
    for e in public:
        if e["action"] in ("freeze", "destroy") and (e["chain"], e["address"]) in best:
            sdn_addr_chain[(e["issuer"], e["chain"])].add(e["address"])
    sdn_screening = {f"{i}:{c}": len(s) for (i, c), s in sdn_addr_chain.items()}

    return {
        "by_issuer": by_issuer,
        "multi_chain_addresses": len(multi),
        "multi_chain_pairs": dict(pair_counts),
        "freeze_to_destroy_days": _quantiles(destroy_lags),
        "freeze_to_release_days": _quantiles(release_lags),
        "sdn_screening": sdn_screening,
        "schema_version": 1,
        "events_total": len(events),
        "events_public": len(public),
        "events_issuer_internal": len(internal),
        "by_chain_action": {c: dict(v) for c, v in by_chain_action.items()},
        "by_token_action": {t: dict(v) for t, v in by_token_action.items()},
        "currently_frozen": {c: dict(v) for c, v in frozen_now.items()},
        "currently_frozen_total": sum(sum(v.values()) for v in frozen_now.values()),
        "destroyed_usdt_by_chain": {c: f"{v:.6f}" for c, v in destroyed.items()},
        "monthly_freezes": monthly_series,
        "attribution_coverage": coverage,
        "attribution_coverage_by_chain": per_chain_cov,
        "top_programs": programs.most_common(15),
        "coverage_span": span,
        "checkpoints": checkpoints or {},
        "last_run": run_log or {},
    }


def write_latest(events=None, attributions=None, out: Path | None = None) -> dict:
    events = events if events is not None else event_store().rows()
    attributions = attributions if attributions is not None else attribution_store().rows()
    cps = Checkpoints().data
    run_log_path = paths.data_dir() / "run_log.json"
    run_log = json.loads(run_log_path.read_text(encoding="utf-8")) if run_log_path.exists() else {}
    views = compute_views(events, attributions, cps, run_log)
    views["generated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    views["files"] = {
        "freeze_events.csv": {"sha256": _sha(paths.events_csv()), "rows": len(events)},
        "attributions.csv": {"sha256": _sha(paths.attributions_csv()), "rows": len(attributions)},
        "evidence.csv": {"sha256": _sha(paths.evidence_csv())},
    }
    views["registry"] = registry.describe()
    out = out or paths.latest_json()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(views, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return views


def write_site_json(events=None, attributions=None, out: Path | None = None) -> dict:
    """Compact columnar form of the public ledger for the site's scene.
    Parallel arrays, one entry per event, sorted by time. Strings that repeat
    (chains, tokens, actions, sources) are small integer codes."""
    events = events if events is not None else event_store().rows()
    attributions = attributions if attributions is not None else attribution_store().rows()
    chains = registry.all_chains()
    tokens = ["USDT", "USDC"]
    actions = ["freeze", "unfreeze", "destroy"]
    best: dict[tuple[str, str], dict] = {}
    for a in attributions:
        if a.get("superseded_by"):
            continue
        k = (a["chain"], a["address"])
        cur = best.get(k)
        if cur is None or CONF_ORDER[a["confidence"]] > CONF_ORDER[cur["confidence"]]:
            best[k] = a
    entity_index: dict[str, int] = {}
    entities: list[dict] = []

    def ent_id(a: dict | None) -> int:
        if a is None:
            return -1
        name = a.get("entity") or f"{a['source_class']} (entity pending)"
        if name not in entity_index:
            entity_index[name] = len(entities)
            entities.append({"name": name, "source": a["source_class"], "program": a.get("program", "")})
        return entity_index[name]

    rows = sorted(events, key=lambda e: (e["block_time"], int(e["block_number"]), int(e["log_index"])))
    t, c, k, a, addr, amt, tx, li, blk, conf, ent, internal = ([] for _ in range(12))
    from datetime import datetime as _dt

    for e in rows:
        t.append(int(_dt.fromisoformat(e["block_time"].replace("Z", "+00:00")).timestamp()))
        c.append(chains.index(e["chain"]))
        k.append(tokens.index(e["token"]))
        a.append(actions.index(e["action"]))
        addr.append(e["address"])
        amt.append(float(e["amount"]) if e.get("amount") else None)
        tx.append(e["tx_hash"])
        li.append(int(e["log_index"]))
        blk.append(int(e["block_number"]))
        b = best.get((e["chain"], e["address"]))
        conf.append(CONF_ORDER[b["confidence"]] if b else 0)
        ent.append(ent_id(b))
        internal.append(1 if e.get("issuer_internal") == "true" else 0)
    doc = {
        "v": 1,
        "n": len(rows),
        "chains": chains,
        "tokens": tokens,
        "actions": actions,
        "entities": entities,
        "t": t, "c": c, "k": k, "a": a, "addr": addr, "amt": amt, "tx": tx, "li": li, "blk": blk,
        "conf": conf, "ent": ent, "internal": internal,
    }
    out = out or (paths.data_dir() / "site.json")
    out.write_text(json.dumps(doc, separators=(",", ":")) + "\n", encoding="utf-8")
    return doc


def write_parquet(log=print) -> list[Path]:
    """Optional Parquet copies of the three tables (needs pyarrow)."""
    try:
        import pyarrow as pa  # type: ignore
        import pyarrow.csv as pacsv  # type: ignore
        import pyarrow.parquet as pq  # type: ignore
    except ImportError:
        log("[export] pyarrow not installed; skipping parquet (pip install freeze-ledger[parquet])")
        return []
    out = []
    for p in (paths.events_csv(), paths.attributions_csv(), paths.evidence_csv()):
        if not p.exists():
            continue
        table = pacsv.read_csv(p, convert_options=pacsv.ConvertOptions(strings_can_be_null=False))
        dest = p.with_suffix(".parquet")
        pq.write_table(table, dest)
        out.append(dest)
        log(f"[export] wrote {dest.name} ({table.num_rows} rows)")
    return out
