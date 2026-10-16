"""The page must not say a chain is missing once it is indexed.

Coverage sentences on the site are built from `coverage` in latest.json,
which export.py reads from the checkpoints. This guards against the old
failure: a caveat typed into a component ("Tron and Solana are not indexed
yet") that stayed on the page after the backfill landed."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site" / "src"
STALE = re.compile(r"\b(Ethereum|Base|Tron|Solana)\b[^.\n`\"]{0,60}\bnot (?:yet )?indexed", re.IGNORECASE)


def _complete_chains() -> set[str]:
    latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
    by_chain: dict[str, list[bool]] = {}
    for lane in (latest.get("coverage") or {}).values():
        by_chain.setdefault(lane["chain"], []).append(bool(lane["complete"]))
    return {c for c, flags in by_chain.items() if all(flags)}


def test_no_hand_written_not_indexed_claims_for_complete_chains():
    complete = _complete_chains()
    hits = []
    for path in sorted(SITE.rglob("*.ts*")):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for m in STALE.finditer(line):
                if m.group(1).lower() in complete:
                    hits.append(f"{path.relative_to(ROOT)}:{n}: {m.group(0)}")
    assert not hits, "site copy says an indexed chain is missing:\n" + "\n".join(hits)


def test_latest_json_states_coverage_for_every_lane():
    latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
    cov = latest["coverage"]
    assert {"ethereum:USDT", "ethereum:USDC", "base:USDC", "tron:USDT", "solana:USDC", "solana:USDT"} <= set(cov)
    for lane in cov.values():
        assert lane["complete"] or lane["note"], f"{lane['chain']} {lane['token']} is incomplete without saying why"
