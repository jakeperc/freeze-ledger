"""The adapter interface every chain implements.

An adapter knows how to read its chain and turn what it reads into
FreezeEvent rows. It does not know about CSV files, checkpoints or the
site: `run()` is handed those and reports what it did.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Callable

from ..checkpoint import Checkpoints
from ..receipts import Receipts, utcnow_iso
from ..store import CsvTable, FreezeEvent

Log = Callable[[str], None]


def iso_from_unix(ts: int | float) -> str:
    return datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat().replace("+00:00", "Z")


@dataclass
class RunStats:
    chain: str
    events_seen: int = 0
    events_new: int = 0
    calls: int = 0
    cursor_from: str = ""
    cursor_to: str = ""
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "chain": self.chain,
            "events_seen": self.events_seen,
            "events_new": self.events_new,
            "calls": self.calls,
            "cursor_from": self.cursor_from,
            "cursor_to": self.cursor_to,
            "notes": self.notes,
        }


class Adapter(abc.ABC):
    chain: str

    @abc.abstractmethod
    def run(
        self,
        checkpoints: Checkpoints,
        store: CsvTable,
        receipts: Receipts,
        log: Log,
        *,
        backfill: bool = False,
        from_cursor: int | str | None = None,
        to_cursor: int | str | None = None,
        max_calls: int | None = None,
    ) -> RunStats:
        """Index forward from the checkpoint (or `from_cursor`), appending new
        rows to `store` with receipts, and advance the checkpoint. With
        `backfill=True` the adapter starts from the beginning of the
        contract's history when no checkpoint exists."""

    @staticmethod
    def make_event(
        *,
        chain: str,
        issuer: str,
        token: str,
        action: str,
        address: str,
        owner_address: str,
        amount: str,
        block_number: int,
        block_time: str,
        tx_hash: str,
        log_index: int,
        issuer_internal: bool,
        evidence_id: str,
    ) -> FreezeEvent:
        return FreezeEvent(
            event_id=f"{chain}:{tx_hash}:{log_index}",
            chain=chain,
            issuer=issuer,
            token=token,
            action=action,
            address=address,
            owner_address=owner_address,
            amount=amount,
            block_number=block_number,
            block_time=block_time,
            tx_hash=tx_hash,
            log_index=log_index,
            issuer_internal="true" if issuer_internal else "",
            evidence_id=evidence_id,
            indexed_at=utcnow_iso(),
        )
