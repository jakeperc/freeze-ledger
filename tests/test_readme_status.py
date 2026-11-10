"""The README's Status block is rendered from latest.json and nothing else."""

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("readme_status", ROOT / "scripts" / "readme_status.py")
rs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rs)

LATEST = {
    "generated_at": "2026-01-02T03:04:05Z",
    "events_public": 1234,
    "events_issuer_internal": 5,
    "currently_frozen_total": 30,
    "currently_frozen": {"tron": {"USDT": 20}, "ethereum": {"USDC": 10}},
    "destroyed_usdt_by_chain": {"ethereum": "1000.400000", "tron": "2500.600000"},
    "coverage": {
        "tron:USDT": {"complete": True, "first": "2020-06-26T00:00:00Z", "last": "2026-01-01T00:00:00Z", "note": ""},
        "solana:USDT": {"complete": False, "first": None, "last": None, "note": "not indexed yet"},
    },
    "attribution_coverage": {"high": 7, "moderate": 2, "low": 0, "unattributed": 21, "unattributed_share": 0.7},
    "sdn_listing_lag_days": {
        "tether:tron": {"n": 12, "median": -1, "before_listing": 3},
        "circle:solana": {"n": 1, "median": 0, "before_listing": 0},
    },
    "sdn_delisted": {"removed_addresses": 4, "lanes": {"circle:base": {"frozen_when_removed": 4, "released_after_removal": 4, "median_days_after_removal": 0}}},
}


def test_every_figure_comes_from_the_export():
    out = rs.render(LATEST)
    assert "As of the export of 2026-01-02" in out
    assert "**1,234** public (5 issuer-internal" in out
    assert "**30** (Tron USDT 20, Ethereum USDC 10)" in out
    assert "**$3,501**" in out  # 1000.4 + 2500.6, rounded once, not per chain
    assert "Tron USDT 2020-06-26 → 2026-01-01" in out
    assert "Solana USDT (not indexed yet)" in out
    assert "**21** (70.0%)" in out
    assert "Tether on Tron 1 day before listing (n=12, 3 frozen more than a week before listing)" in out
    assert "Circle on Base released 4 of 4 (median the same day as the removal)" in out


def test_lanes_with_too_few_listings_are_left_out():
    assert "Circle on Solana" not in rs.render(LATEST)


def test_splice_keeps_everything_outside_the_markers():
    readme = f"top\n{rs.START}\nold\n{rs.END}\nbottom\n"
    assert rs.splice(readme, "new") == f"top\n{rs.START}\nnew\n{rs.END}\nbottom\n"
    with pytest.raises(SystemExit):
        rs.splice("no markers", "new")


def test_check_mode(tmp_path):
    latest = tmp_path / "latest.json"
    latest.write_text(json.dumps(LATEST), encoding="utf-8")
    readme = tmp_path / "README.md"
    readme.write_text(f"x\n{rs.START}\nstale\n{rs.END}\n", encoding="utf-8")
    args = ["--latest", str(latest), "--readme", str(readme)]
    assert rs.main(args + ["--check"]) == 1
    assert rs.main(args) == 0
    assert rs.main(args + ["--check"]) == 0


def test_committed_export_renders():
    latest = json.loads((ROOT / "data" / "latest.json").read_text(encoding="utf-8"))
    assert rs.render(latest).startswith("As of the export of " + latest["generated_at"][:10])
