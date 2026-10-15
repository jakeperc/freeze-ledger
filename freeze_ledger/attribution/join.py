"""Build the attributions table from the SDN extract, the manual records
file, and the freeze events.

Automatic: an exact normalized-address match between a frozen address and an
SDN digital-currency address (same address family: EVM, Tron or Solana).

Manual: rows in data/attributions_manual.csv, one per (address, record),
for DOJ filings, court records, issuer statements and explorer labels that
no parser can match by itself. Columns:

    address, chain, source_class, entity, program, record_date, evidence_url,
    match_basis, amount_matches, notes

Both paths go through grade.py. A re-judgment that changes a rating appends
a new row and marks the old one superseded; nothing is edited in place.
"""

from __future__ import annotations

import csv
import hashlib
from collections import defaultdict
from datetime import datetime, timezone

from .. import paths, registry
from ..store import ATTRIBUTION_COLUMNS, CsvTable, attribution_store, event_store
from . import federal_register, grade as grading
from .sdn import read_sdn_csv

SANCTIONS_SEARCH = "https://sanctionssearch.ofac.treas.gov/Details.aspx?id={fixed_ref}"

FAMILY = {"ethereum": "evm", "base": "evm", "tron": "tron", "solana": "solana"}


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _attr_id(address: str, chain: str, source_class: str, evidence_url: str, confidence: str) -> str:
    h = hashlib.sha1(f"{address}|{chain}|{source_class}|{evidence_url}|{confidence}".encode()).hexdigest()
    return "at_" + h[:16]


def _first_freeze_dates(events: list[dict]) -> dict[tuple[str, str], str]:
    """(chain, address) -> earliest freeze block_time."""
    first: dict[tuple[str, str], str] = {}
    for e in events:
        if e["action"] not in ("freeze", "destroy"):
            continue
        k = (e["chain"], e["address"])
        if k not in first or e["block_time"] < first[k]:
            first[k] = e["block_time"]
    return first


def read_manual(path=None) -> list[dict]:
    path = path or paths.manual_attributions_csv()
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r.get("address")]


def build_attributions(
    *,
    events: list[dict] | None = None,
    sdn_rows: list[dict] | None = None,
    manual_rows: list[dict] | None = None,
    use_federal_register: bool = True,
    store: CsvTable | None = None,
    log=print,
) -> dict:
    events = events if events is not None else event_store().rows()
    sdn_rows = sdn_rows if sdn_rows is not None else read_sdn_csv()
    manual_rows = manual_rows if manual_rows is not None else read_manual()
    store = store or attribution_store()

    first_freeze = _first_freeze_dates(events)
    frozen_by_family: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for (chain, address) in first_freeze:
        frozen_by_family[FAMILY[chain]][address].append(chain)

    candidates: list[dict] = []

    # --- automatic: SDN exact matches ---------------------------------------
    sdn_hits = 0
    for row in sdn_rows:
        fam = row["chain_hint"]
        if fam not in frozen_by_family:
            continue
        chains = frozen_by_family[fam].get(row["address_norm"])
        if not chains:
            continue
        sdn_hits += 1
        evidence_url = SANCTIONS_SEARCH.format(fixed_ref=row["fixed_ref"]) if row["fixed_ref"] else row.get("source_url", "")
        pending = "" if (row["entity"] or row["listed_date"]) else "; entity and listing date pending the full SDN XML parse (independent nightly extract)"
        notice = None
        if use_federal_register and row["entity"] and row["listed_date"]:
            notice = federal_register.find_notice(row["entity"], row["listed_date"], log=log)
        for chain in chains:
            g = grading.grade(
                source_class="ofac_sdn",
                match_basis="address",
                freeze_date=first_freeze[(chain, row["address_norm"])],
                record_date=row["listed_date"],
            )
            candidates.append(
                {
                    "address": row["address_norm"],
                    "chain": chain,
                    "source_class": "ofac_sdn",
                    "entity": row["entity"],
                    "program": row["program"],
                    "record_date": row["listed_date"],
                    "confidence": g.confidence,
                    "basis": g.basis + f" (SDN asset code {row['asset']})" + pending,
                    "evidence_url": evidence_url,
                }
            )
            if notice and notice.get("html_url"):
                g2 = grading.grade(
                    source_class="federal_register",
                    match_basis="address",
                    freeze_date=first_freeze[(chain, row["address_norm"])],
                    record_date=notice.get("publication_date", row["listed_date"]),
                )
                candidates.append(
                    {
                        "address": row["address_norm"],
                        "chain": chain,
                        "source_class": "federal_register",
                        "entity": row["entity"],
                        "program": row["program"],
                        "record_date": notice.get("publication_date", ""),
                        "confidence": g2.confidence,
                        "basis": g2.basis + f" (via SDN entry; notice: {notice.get('title', '')[:120]})",
                        "evidence_url": notice["html_url"],
                    }
                )

    # --- manual records ------------------------------------------------------
    for row in manual_rows:
        chain = row["chain"].strip()
        address = row["address"].strip()
        fd = first_freeze.get((chain, address), "")
        g = grading.grade(
            source_class=row["source_class"].strip(),
            match_basis=(row.get("match_basis") or "secondary").strip(),
            freeze_date=fd,
            record_date=(row.get("record_date") or "").strip(),
            amount_matches=str(row.get("amount_matches", "")).strip().lower() in ("true", "1", "yes"),
        )
        candidates.append(
            {
                "address": address,
                "chain": chain,
                "source_class": row["source_class"].strip(),
                "entity": (row.get("entity") or "").strip(),
                "program": (row.get("program") or "").strip(),
                "record_date": (row.get("record_date") or "").strip(),
                "confidence": g.confidence,
                "basis": g.basis + (f" — {row['notes'].strip()}" if row.get("notes") else ""),
                "evidence_url": (row.get("evidence_url") or "").strip(),
            }
        )

    # --- write, superseding changed ratings -----------------------------------
    existing = store.rows()
    by_key: dict[tuple, dict] = {}
    for r in existing:
        if r.get("superseded_by"):
            continue
        by_key[(r["address"], r["chain"], r["source_class"], r["evidence_url"])] = r

    # Rows judged from the independent extract (`sdn --independent`) cite a
    # list URL rather than the SDN entry, so their key never matches the
    # graded row that replaces them; supersede them by address instead.
    independent_urls = set(registry.B10C_LISTS.values())
    placeholders: dict[tuple, list[dict]] = defaultdict(list)
    for r in existing:
        if not r.get("superseded_by") and r["evidence_url"] in independent_urls:
            placeholders[(r["address"], r["chain"], r["source_class"])].append(r)

    new_rows: list[dict] = []
    superseded: dict[str, str] = {}
    today = _today()
    for c in candidates:
        key = (c["address"], c["chain"], c["source_class"], c["evidence_url"])
        aid = _attr_id(*key, c["confidence"])
        prev = by_key.get(key)
        if prev and prev["confidence"] == c["confidence"]:
            continue
        row = {**c, "attribution_id": aid, "judged_at": today, "superseded_by": ""}
        new_rows.append(row)
        if prev:
            superseded[prev["attribution_id"]] = aid
        elif c["evidence_url"] not in independent_urls:
            for ph in placeholders.pop((c["address"], c["chain"], c["source_class"]), []):
                superseded[ph["attribution_id"]] = aid

    if superseded:
        rewritten = []
        for r in existing:
            if r["attribution_id"] in superseded:
                r = {**r, "superseded_by": superseded[r["attribution_id"]]}
            rewritten.append(r)
        store.rewrite(rewritten)
    written = store.append(new_rows)
    summary = {
        "frozen_addresses": len(first_freeze),
        "sdn_rows": len(sdn_rows),
        "sdn_matches": sdn_hits,
        "manual_rows": len(manual_rows),
        "attributions_written": written,
        "attributions_superseded": len(superseded),
    }
    log(f"[attribute] {summary}")
    return summary
