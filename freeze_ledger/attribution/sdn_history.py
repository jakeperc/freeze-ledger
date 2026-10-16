"""When each digital-currency address was on the SDN list.

`sdn_advanced.xml` dates a *party* (its earliest EntryEvent), not each of its
addresses, and many parties had addresses added years after they were first
designated (a central bank designated in 2010 with Tron addresses added in
2025). It also names only the addresses listed today, so an address that was
listed and later removed (the Tornado Cash contracts, delisted 2025-03-21)
drops out of the join entirely.

0xB10C's lists branch is a git history of the nightly SDN address extract:
one commit per night on which the list changed, starting 2022-09-03. Walking
it gives, for every address in scope (EVM, Tron, Solana):

- `first_seen`: date of the first commit containing it. The nightly job runs
  every day, so for an address first seen after `NIGHTLY_SINCE` this is the
  listing date to within a day; `not_before` is then the day before.
- for an address already present in the first snapshot (`NIGHTLY_SINCE`),
  the listing date is only bounded: on or before that day. `not_before` is
  left empty and the party's designation date is the lower bound.
- the same holds for an address present in the commit where its asset's file
  first appears: the extract added asset codes over time (USDT 2023-05, TRX
  and USDC 2023-12, SOL 2026-05), so those addresses may have been listed
  long before the file existed.
- `last_seen` / `removed_at`: the last commit containing it and the commit
  that dropped it, for addresses no longer listed.

Commit hashes are content hashes, so every date here can be re-derived by
anyone with `git log` on that branch. The table is written to
data/sdn_address_history.csv and committed, so offline runs keep it.
"""

from __future__ import annotations

import csv
import json
import subprocess
from datetime import date, timedelta
from pathlib import Path

from .. import paths, registry
from .sdn import chain_hint, normalize_for_hint

NIGHTLY_SINCE = "2022-09-03"  # first commit with address lists; the job is nightly from here
IN_SCOPE = ("evm", "tron", "solana")

HISTORY_COLUMNS = [
    "chain_hint",
    "address_norm",
    "assets",
    "first_seen",
    "not_before",
    "last_seen",
    "removed_at",
    "first_commit",
    "removed_commit",
]


def history_csv() -> Path:
    return paths.data_dir() / "sdn_address_history.csv"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True, encoding="utf-8").stdout


def sync_repo(dest: Path, log=print) -> Path:
    """Clone or fast-forward the lists branch into `dest` (gitignored)."""
    if (dest / ".git").exists():
        _git(dest, "fetch", "-q", "origin", registry.B10C_BRANCH)
        _git(dest, "reset", "-q", "--hard", f"origin/{registry.B10C_BRANCH}")
    else:
        dest.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["git", "clone", "-q", "--single-branch", "--branch", registry.B10C_BRANCH, registry.B10C_REPO, str(dest)],
            check=True,
        )
    log(f"[sdn:history] {registry.B10C_REPO}@{registry.B10C_BRANCH} at {_git(dest, 'rev-parse', '--short', 'HEAD').strip()}")
    return dest


def walk(repo: Path) -> list[dict]:
    """One row per in-scope address ever listed, from the branch's history."""
    commits = [line.split() for line in _git(repo, "log", "--reverse", "--format=%H %cI").splitlines() if line.strip()]
    rows: dict[tuple[str, str], dict] = {}
    previous: set[tuple[str, str]] = set()
    files_before: set[str] = set()  # asset codes whose list existed in an earlier commit
    for sha, iso in commits:
        day = iso[:10]
        present: dict[tuple[str, str], set[str]] = {}
        assets_now: set[str] = set()
        for name in _git(repo, "ls-tree", "--name-only", sha).split():
            if not (name.startswith("sanctioned_addresses_") and name.endswith(".json")):
                continue
            asset = name[len("sanctioned_addresses_") : -len(".json")]
            assets_now.add(asset)
            for a in json.loads(_git(repo, "show", f"{sha}:{name}") or "[]"):
                a = str(a).strip()
                hint = chain_hint(asset, a)
                if hint not in IN_SCOPE:
                    continue
                present.setdefault((hint, normalize_for_hint(hint, a)), set()).add(asset)
        if not present and not previous:
            continue  # README-only commits before the lists existed
        for key, assets in present.items():
            r = rows.get(key)
            if r is None:
                # new on a list that was already being extracted: a real addition
                precise = day > NIGHTLY_SINCE and bool(assets & files_before)
                r = rows[key] = {
                    "chain_hint": key[0],
                    "address_norm": key[1],
                    "assets": set(),
                    "first_seen": day,
                    "not_before": (date.fromisoformat(day) - timedelta(days=1)).isoformat() if precise else "",
                    "last_seen": day,
                    "removed_at": "",
                    "first_commit": sha,
                    "removed_commit": "",
                }
            r["assets"] |= assets
            r["last_seen"] = day
            if r["removed_at"]:  # relisted after a removal: keep the first listing, clear the removal
                r["removed_at"] = r["removed_commit"] = ""
        for key in previous - present.keys():
            rows[key]["removed_at"] = day
            rows[key]["removed_commit"] = sha
        previous = set(present)
        files_before |= assets_now
    out = []
    for r in rows.values():
        out.append({**r, "assets": ";".join(sorted(r["assets"]))})
    out.sort(key=lambda r: (r["chain_hint"], r["address_norm"]))
    return out


def write_history(rows: list[dict], path: Path | None = None) -> Path:
    path = path or history_csv()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=HISTORY_COLUMNS, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    return path


def read_history(path: Path | None = None) -> dict[tuple[str, str], dict]:
    path = path or history_csv()
    if not path.exists():
        return {}
    with path.open(newline="", encoding="utf-8") as f:
        return {(r["chain_hint"], r["address_norm"]): r for r in csv.DictReader(f)}


def refresh(log=print) -> Path:
    repo = sync_repo(paths.evidence_dir() / "sdn" / "b10c-lists", log=log)
    rows = walk(repo)
    removed = sum(1 for r in rows if r["removed_at"])
    out = write_history(rows)
    log(f"[sdn:history] {len(rows)} in-scope addresses ever listed ({removed} since removed) -> {out}")
    return out


def listing_window(hist: dict | None, party_date: str) -> tuple[str, str]:
    """(earliest, latest) date the address can have been listed.

    latest is the first nightly snapshot that holds it; earliest is the day
    before that when the snapshot is precise, else the party's designation
    date (an address cannot be listed before its party). With no history row
    both ends are the party date, which is what the grade used before."""
    if not hist:
        return party_date, party_date
    latest = hist["first_seen"]
    earliest = hist["not_before"] or party_date or ""
    if earliest and earliest > latest:
        earliest = latest
    return earliest, latest
