"""ICD-203-style confidence rules, applied mechanically.

The freeze is a fact; what is graded is the claim "this freeze is explained
by this record". Every rating comes with a `basis` sentence that says why it
is not one level higher, so a reader can argue with it.

Levels: high, moderate, low. "unattributed" is not a rating; it is the
absence of a row, and is counted as such in the export.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

PRIMARY_SOURCES = {"ofac_sdn", "federal_register", "doj", "court"}
SECONDARY_SOURCES = {"issuer", "explorer_label", "press", "tracker"}

# A freeze this long before the record's date is not explained by it as the
# trigger; the record still corroborates the actor.
PRE_RECORD_GRACE_DAYS = 30


@dataclass(frozen=True)
class Grade:
    confidence: str
    basis: str


def _to_date(s: str) -> date | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).date()
    except ValueError:
        try:
            return date.fromisoformat(s[:10])
        except ValueError:
            return None


def grade(
    *,
    source_class: str,
    match_basis: str,
    freeze_date: str,
    record_date: str,
    amount_matches: bool = False,
    record_date_earliest: str = "",
) -> Grade:
    """
    source_class: ofac_sdn | federal_register | doj | court | issuer | explorer_label | press | tracker
    match_basis:  address | amount_date | date | secondary
    record_date_earliest: when the record's date is only bounded (an SDN
        address known to be listed on or before `record_date` but not exactly
        when), the earliest it can be. High needs the freeze to be no earlier
        than 30 days before the latest possible date; Moderate is certain only
        when it is more than 30 days before the earliest. In between, the
        record may postdate the freeze, so it is Moderate with that said.
    """
    fd, rd = _to_date(freeze_date), _to_date(record_date)
    delta = (fd - rd).days if (fd and rd) else None
    primary = source_class in PRIMARY_SOURCES

    if match_basis == "address" and primary:
        if delta is None:
            return Grade("high", "exact address match in a primary record; record or freeze date unknown, so timing not assessed")
        if delta >= -PRE_RECORD_GRACE_DAYS:
            when = f"{delta} days after" if delta >= 0 else f"{-delta} days before"
            return Grade("high", f"exact address match in a primary record; freeze {when} the record date")
        ed = _to_date(record_date_earliest) or rd
        if ed > rd:
            ed = rd
        early = (fd - ed).days
        if early < -PRE_RECORD_GRACE_DAYS:
            by = f"{-early} days" if ed == rd else f"at least {-early} days"
            return Grade(
                "moderate",
                f"exact address match in a primary record, but the freeze predates it by {by}: the record corroborates the actor, not the trigger",
            )
        return Grade(
            "moderate",
            f"exact address match in a primary record, listed between {ed.isoformat()} and {rd.isoformat()}; the freeze on {fd.isoformat()} falls in that window, so the record may postdate it",
        )

    if match_basis == "address" and not primary:
        return Grade("low", "exact address match, but the only source is secondary (no SDN entry, filing or notice names the address)")

    if match_basis == "amount_date":
        if primary and amount_matches:
            return Grade("moderate", "primary record cites an amount and date that match a single destroy event; the record lists no address")
        if primary:
            return Grade("low", "primary record near the freeze date, but neither the address nor the amount is stated in it")
        return Grade("moderate" if amount_matches else "low", "issuer or secondary statement names the action and amount; no primary record lists the address")

    if match_basis in ("date", "secondary"):
        return Grade("low", "secondary source or date proximity only; nothing primary corroborates the link")

    raise ValueError(f"unknown match_basis {match_basis!r}")


def corroborate(existing: str, candidate: str, both_primary: bool) -> str:
    """Two ratings for the same address: never raise on two lows; raise
    moderate to high only when a second primary source agrees."""
    order = {"low": 0, "moderate": 1, "high": 2}
    best = max(existing, candidate, key=lambda c: order[c])
    if existing == "moderate" and candidate == "moderate" and both_primary:
        return "high"
    return best
