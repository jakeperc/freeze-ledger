"""Rewrite the README's Status block from data/latest.json.

The block sits between `<!-- status:start -->` and `<!-- status:end -->`.
Every figure in it is read from the export, and the date it states is the
export's own `generated_at`, so the README can only say what the data says
and never carries a date the numbers do not have.

    python scripts/readme_status.py           # rewrite README.md in place
    python scripts/readme_status.py --check   # exit 1 if README.md is stale

Standard library only, like the rest of the repository.
"""

from __future__ import annotations

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
START, END = "<!-- status:start -->", "<!-- status:end -->"

CHAIN = {"ethereum": "Ethereum", "base": "Base", "tron": "Tron", "solana": "Solana"}
ISSUER = {"tether": "Tether", "circle": "Circle"}


def _int(n: int | float) -> str:
    return f"{int(n):,}"


def _usd(s: str | int | float) -> str:
    return f"${Decimal(str(s)).quantize(Decimal(1)):,}"


def _day(iso: str | None) -> str:
    return (iso or "")[:10]


def _lane(key: str) -> str:
    chain, token = key.split(":")
    return f"{CHAIN.get(chain, chain)} {token}"


def _issuer_lane(key: str) -> str:
    issuer, chain = key.split(":")
    return f"{ISSUER.get(issuer, issuer)} on {CHAIN.get(chain, chain)}"


def _days(d: float) -> str:
    if d == 0:
        return "the same day"
    if d < 0:
        return f"{abs(d):g} day{'s' if abs(d) != 1 else ''} before listing"
    return f"{d:g} day{'s' if d != 1 else ''}"


def _after(d: float | None) -> str:
    if d is None:  # the night after a delisting, before any release
        return "none released yet"
    return "the same day as the removal" if d == 0 else f"{d:g} day{'s' if d != 1 else ''} after removal"


def render(latest: dict) -> str:
    """The Markdown between the markers, from an export."""
    gen = _day(latest["generated_at"])
    lines = [f"As of the export of {gen} (`data/latest.json`; regenerate with `python scripts/readme_status.py`):", ""]

    lines.append(
        f"- Events indexed: **{_int(latest['events_public'])}** public "
        f"({_int(latest['events_issuer_internal'])} issuer-internal rows kept and flagged)"
    )

    frozen = latest["currently_frozen"]
    parts = sorted(
        ((f"{CHAIN.get(c, c)} {t}", n) for c, by in frozen.items() for t, n in by.items()),
        key=lambda x: -x[1],
    )
    lines.append(
        f"- Addresses frozen now: **{_int(latest['currently_frozen_total'])}** ("
        + ", ".join(f"{name} {_int(n)}" for name, n in parts)
        + ")"
    )

    destroyed = latest.get("destroyed_usdt_by_chain") or {}
    if destroyed:
        total = sum(Decimal(v) for v in destroyed.values())
        lines.append(
            f"- USDT destroyed after a freeze (all-time): **{_usd(total)}** ("
            + ", ".join(f"{CHAIN.get(c, c)} {_usd(v)}" for c, v in sorted(destroyed.items(), key=lambda x: -Decimal(x[1])))
            + ")"
        )

    cov = latest.get("coverage") or {}
    done = [f"{_lane(k)} {_day(v['first'])} → {_day(v['last'])}" for k, v in sorted(cov.items()) if v.get("complete")]
    open_ = [f"{_lane(k)} ({v.get('note') or 'not complete'})" for k, v in sorted(cov.items()) if not v.get("complete")]
    if done:
        lines.append("- Coverage, complete from each lane's first event: " + "; ".join(done))
    if open_:
        lines.append("- Not yet covered: " + "; ".join(open_))

    a = latest["attribution_coverage"]
    lines.append(
        f"- Attribution: **{_int(a['high'])}** frozen addresses with a High attribution, **{_int(a['moderate'])}** Moderate"
        + (f", {_int(a['low'])} Low" if a.get("low") else "")
        + f"; **{_int(a['unattributed'])}** ({a['unattributed_share'] * 100:.1f}%) with no public record found yet"
    )

    lag = latest.get("sdn_listing_lag_days") or {}
    shown = [(k, v) for k, v in sorted(lag.items()) if v.get("n", 0) >= 10]
    if shown:
        lines.append(
            "- OFAC listing to freeze, addresses listed to the day (median; the nightly SDN extract records a listing up to a day late, so \"1 day before listing\" is effectively the listing day): "
            + "; ".join(
                f"{_issuer_lane(k)} {_days(v['median'])} (n={_int(v['n'])}"
                + (f", {_int(v['before_listing'])} frozen more than a week before listing" if v.get("before_listing") else "")
                + ")"
                for k, v in shown
            )
        )

    dl = (latest.get("sdn_delisted") or {}).get("lanes") or {}
    if dl:
        lines.append(
            f"- Addresses OFAC has removed: {_int(latest['sdn_delisted'].get('removed_addresses', 0))}; "
            + "; ".join(
                f"{_issuer_lane(k)} released {_int(v['released_after_removal'])} of {_int(v['frozen_when_removed'])} "
                + (
                    f"(median {_after(v['median_days_after_removal'])})"
                    if v.get("median_days_after_removal") is not None
                    else "(none released yet)"
                )
                for k, v in sorted(dl.items())
            )
        )
    return "\n".join(lines)


def splice(readme: str, block: str) -> str:
    i, j = readme.find(START), readme.find(END)
    if i < 0 or j < i:
        raise SystemExit(f"README.md has no {START} … {END} block")
    return readme[: i + len(START)] + "\n" + block + "\n" + readme[j:]


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--check", action="store_true", help="exit 1 if README.md does not match the export")
    p.add_argument("--latest", type=Path, default=ROOT / "data" / "latest.json")
    p.add_argument("--readme", type=Path, default=ROOT / "README.md")
    args = p.parse_args(argv)

    latest = json.loads(args.latest.read_text(encoding="utf-8"))
    readme = args.readme.read_text(encoding="utf-8")
    new = splice(readme, render(latest))
    if args.check:
        if new != readme:
            print("README.md Status block is stale; run: python scripts/readme_status.py", file=sys.stderr)
            return 1
        return 0
    if new != readme:
        args.readme.write_text(new, encoding="utf-8", newline="\n")
        print("README.md Status block rewritten from", args.latest.name, latest["generated_at"])
    else:
        print("README.md Status block already current")
    return 0


if __name__ == "__main__":
    sys.exit(main())
