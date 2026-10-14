"""Receipts before rows.

Every raw response a row is derived from is hashed with SHA-256 and written
under evidence/raw/{YYYY-MM-DD}/ before the row exists. The row carries the
receipt's id; the verification suite checks the file still hashes to the
recorded value. Identical responses share one receipt.
"""

from __future__ import annotations

import csv
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from . import paths

EVIDENCE_COLUMNS = ["evidence_id", "kind", "locator", "fetched_at", "sha256", "bytes"]


def utcnow_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class Receipts:
    def __init__(self, raw_root: Path | None = None, index_csv: Path | None = None):
        self.raw_root = raw_root or (paths.evidence_dir() / "raw")
        self.index_csv = index_csv or paths.evidence_csv()
        self.raw_root.mkdir(parents=True, exist_ok=True)
        self.index_csv.parent.mkdir(parents=True, exist_ok=True)
        self._known: dict[str, str] = {}  # sha256 -> evidence_id
        self._load()

    def _load(self) -> None:
        if not self.index_csv.exists():
            return
        with self.index_csv.open(newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                self._known[row["sha256"]] = row["evidence_id"]

    @staticmethod
    def evidence_id_for(sha256: str) -> str:
        return "ev_" + sha256[:16]

    def record(self, kind: str, locator: str, raw: bytes) -> str:
        """Hash `raw`, file it, index it, and return its evidence_id."""
        sha = hashlib.sha256(raw).hexdigest()
        if sha in self._known:
            return self._known[sha]
        eid = self.evidence_id_for(sha)
        day = utcnow_iso()[:10]
        folder = self.raw_root / day
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{sha[:16]}.json"
        if not path.exists():
            path.write_bytes(raw)
        new_file = not self.index_csv.exists() or self.index_csv.stat().st_size == 0
        with self.index_csv.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=EVIDENCE_COLUMNS)
            if new_file:
                w.writeheader()
            w.writerow(
                {
                    "evidence_id": eid,
                    "kind": kind,
                    "locator": locator,
                    "fetched_at": utcnow_iso(),
                    "sha256": sha,
                    "bytes": len(raw),
                }
            )
        self._known[sha] = eid
        return eid

    def record_hash_only(self, kind: str, locator: str, sha256: str, size: int) -> str:
        """Index a receipt for a response too large to keep (the SDN XML).
        The hash and size are recorded so a re-download can be compared."""
        if sha256 in self._known:
            return self._known[sha256]
        eid = self.evidence_id_for(sha256)
        new_file = not self.index_csv.exists() or self.index_csv.stat().st_size == 0
        with self.index_csv.open("a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=EVIDENCE_COLUMNS)
            if new_file:
                w.writeheader()
            w.writerow(
                {
                    "evidence_id": eid,
                    "kind": kind,
                    "locator": locator,
                    "fetched_at": utcnow_iso(),
                    "sha256": sha256,
                    "bytes": size,
                }
            )
        self._known[sha256] = eid
        return eid

    def find_raw(self, sha256: str) -> Path | None:
        """Locate the raw file for a hash (any day folder)."""
        name = f"{sha256[:16]}.json"
        for p in sorted(self.raw_root.glob(f"*/{name}")):
            return p
        return None

    def index_rows(self) -> list[dict]:
        if not self.index_csv.exists():
            return []
        with self.index_csv.open(newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))
