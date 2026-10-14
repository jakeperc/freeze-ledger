"""Append-only CSV stores for the three tables, with event_id de-duplication.

Rows are plain dicts so the tables stay readable with any tool. Parquet is a
derived export (see export.py), never the source of truth.
"""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable

from . import paths

EVENT_COLUMNS = [
    "event_id",
    "chain",
    "issuer",
    "token",
    "action",
    "address",
    "owner_address",
    "amount",
    "block_number",
    "block_time",
    "tx_hash",
    "log_index",
    "issuer_internal",
    "evidence_id",
    "indexed_at",
]

ATTRIBUTION_COLUMNS = [
    "attribution_id",
    "address",
    "chain",
    "source_class",
    "entity",
    "program",
    "record_date",
    "confidence",
    "basis",
    "evidence_url",
    "judged_at",
    "superseded_by",
]


@dataclass
class FreezeEvent:
    event_id: str
    chain: str
    issuer: str
    token: str
    action: str  # freeze | unfreeze | destroy
    address: str
    owner_address: str  # Solana only, else ""
    amount: str  # token units as a decimal string, destroy events only, else ""
    block_number: int
    block_time: str  # ISO-8601 UTC
    tx_hash: str
    log_index: int
    issuer_internal: str  # "true" when the address is the issuer's own contract/mint
    evidence_id: str
    indexed_at: str

    def as_row(self) -> dict:
        d = asdict(self)
        return {k: ("" if d[k] is None else str(d[k])) for k in EVENT_COLUMNS}


class CsvTable:
    def __init__(self, path: Path, columns: list[str], key: str):
        self.path = path
        self.columns = columns
        self.key = key
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._keys: set[str] = set()
        self._load_keys()

    def _load_keys(self) -> None:
        if not self.path.exists():
            return
        with self.path.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self._keys.add(row[self.key])

    def __contains__(self, key: str) -> bool:
        return key in self._keys

    def __len__(self) -> int:
        return len(self._keys)

    def rows(self) -> list[dict]:
        if not self.path.exists():
            return []
        with self.path.open(newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))

    def append(self, rows: Iterable[dict]) -> int:
        """Append rows whose key is new. Returns the number written."""
        new_file = not self.path.exists() or self.path.stat().st_size == 0
        written = 0
        with self.path.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=self.columns, extrasaction="ignore")
            if new_file:
                w.writeheader()
            for row in rows:
                k = row[self.key]
                if k in self._keys:
                    continue
                w.writerow({c: row.get(c, "") for c in self.columns})
                self._keys.add(k)
                written += 1
        return written

    def rewrite(self, rows: Iterable[dict]) -> None:
        """Replace the whole table (used only by corrections, which are logged
        in CHANGELOG.md)."""
        rows = list(rows)
        with self.path.open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=self.columns, extrasaction="ignore")
            w.writeheader()
            for row in rows:
                w.writerow({c: row.get(c, "") for c in self.columns})
        self._keys = {r[self.key] for r in rows}


def event_store(path: Path | None = None) -> CsvTable:
    return CsvTable(path or paths.events_csv(), EVENT_COLUMNS, "event_id")


def attribution_store(path: Path | None = None) -> CsvTable:
    return CsvTable(path or paths.attributions_csv(), ATTRIBUTION_COLUMNS, "attribution_id")
