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
from .sdn_history import listing_window, read_history

B10C_COMMIT = "https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses/commit/{sha}"
UNKNOWN_EARLIEST = "1990-01-01"  # listing date bounded above only
FR_MATCH_DAYS = 45  # a notice this close to the address's listing window is the one that added it
REMOVED_MARK = "removed from the SDN list on"
WITHDRAWN = "withdrawn"  # superseded_by value for a row no rule produces any more

SANCTIONS_SEARCH = "https://sanctionssearch.ofac.treas.gov/Details.aspx?id={fixed_ref}"

FAMILY = {"ethereum": "evm", "base": "evm", "tron": "tron", "solana": "solana"}


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _attr_id(address: str, chain: str, source_class: str, evidence_url: str, confidence: str, record_date: str = "", basis: str = "") -> str:
    tail = f"|{record_date}|{basis}" if (record_date or basis) else ""
    h = hashlib.sha1(f"{address}|{chain}|{source_class}|{evidence_url}|{confidence}{tail}".encode()).hexdigest()
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


def _listed_note(hist: dict | None, party_date: str) -> str:
    """How the address's listing date is known, for the basis sentence."""
    if not hist:
        return f"address not in the nightly extract history; party designated {party_date or 'on an unknown date'}"
    if hist.get("not_before"):
        note = f"address first in the nightly SDN extract on {hist['first_seen']}"
        if party_date and party_date < hist["not_before"]:
            note += f"; party designated {party_date}"
        return note
    lo = f"party designated {party_date}" if party_date else "earliest date unknown"
    return f"address listed on or before {hist['first_seen']}, the extract's first snapshot; {lo}"


def _near_window(day: str, earliest: str, latest: str) -> bool:
    from datetime import date, timedelta

    try:
        d = date.fromisoformat(day[:10])
        hi = date.fromisoformat(latest[:10]) + timedelta(days=FR_MATCH_DAYS)
        lo = date.fromisoformat((earliest or latest)[:10]) - timedelta(days=FR_MATCH_DAYS)
    except ValueError:
        return False
    return lo <= d <= hi


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
    history: dict | None = None,
    store: CsvTable | None = None,
    log=print,
) -> dict:
    events = events if events is not None else event_store().rows()
    sdn_rows = sdn_rows if sdn_rows is not None else read_sdn_csv()
    history = history if history is not None else read_history()
    manual_rows = manual_rows if manual_rows is not None else read_manual()
    store = store or attribution_store()

    first_freeze = _first_freeze_dates(events)
    frozen_by_family: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for (chain, address) in first_freeze:
        frozen_by_family[FAMILY[chain]][address].append(chain)
    # On Solana the frozen thing is a token account; OFAC lists the wallet that
    # owns it. A listed wallet matches every frozen token account it owns, and
    # the row is written against the token account, which is what joins.
    owned: dict[str, set[str]] = defaultdict(set)
    for e in events:
        if e["chain"] == "solana" and e.get("owner_address") and ("solana", e["address"]) in first_freeze:
            owned[e["owner_address"]].add(e["address"])

    def targets(fam: str, listed: str) -> list[tuple[str, str, str]]:
        """(chain, ledger address, how it matched) for a listed address."""
        out = [(chain, listed, "") for chain in frozen_by_family.get(fam, {}).get(listed, [])]
        if fam == "solana":
            out += [("solana", acct, f"; the listed wallet owns this frozen token account") for acct in sorted(owned.get(listed, ()))]
        return out

    candidates: list[dict] = []

    # --- automatic: SDN exact matches ---------------------------------------
    # The SDN XML dates the party, not the address: a party designated in 2010
    # can have an address added in 2025. The record date graded against is
    # when the *address* was listed, from the nightly extract's history
    # (sdn_history.py); where that is only bounded, the grade says so.
    sdn_hits = 0
    current_keys = {(r["chain_hint"], r["address_norm"]) for r in sdn_rows}
    for row in sdn_rows:
        fam = row["chain_hint"]
        hits = targets(fam, row["address_norm"])
        if not hits:
            continue
        sdn_hits += 1
        evidence_url = SANCTIONS_SEARCH.format(fixed_ref=row["fixed_ref"]) if row["fixed_ref"] else row.get("source_url", "")
        pending = "" if (row["entity"] or row["listed_date"]) else "; entity and listing date pending the full SDN XML parse (independent nightly extract)"
        notice = None
        if use_federal_register and row["entity"] and row["listed_date"]:
            notice = federal_register.find_notice(row["entity"], row["listed_date"], log=log)
        hist = history.get((fam, row["address_norm"]))
        earliest, latest = listing_window(hist, row["listed_date"])
        listed_note = _listed_note(hist, row["listed_date"])
        # A notice for the party's designation names the address only if the
        # address was listed then; a 2010 notice cannot explain an address
        # added in 2025, so it is not linked to it.
        notice_fits = bool(notice and notice.get("html_url") and _near_window(notice.get("publication_date", ""), earliest, latest))
        for chain, ledger_addr, via in hits:
            g = grading.grade(
                source_class="ofac_sdn",
                match_basis="address",
                freeze_date=first_freeze[(chain, ledger_addr)],
                record_date=latest,
                record_date_earliest=earliest or UNKNOWN_EARLIEST,
            )
            candidates.append(
                {
                    "address": ledger_addr,
                    "chain": chain,
                    "source_class": "ofac_sdn",
                    "entity": row["entity"],
                    "program": row["program"],
                    "record_date": latest,
                    "confidence": g.confidence,
                    "basis": g.basis + f" (SDN asset code {row['asset']}; {listed_note}{via})" + pending,
                    "evidence_url": evidence_url,
                }
            )
            if notice_fits:
                g2 = grading.grade(
                    source_class="federal_register",
                    match_basis="address",
                    freeze_date=first_freeze[(chain, ledger_addr)],
                    record_date=notice.get("publication_date", latest),
                )
                candidates.append(
                    {
                        "address": ledger_addr,
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

    # --- removed from the SDN list ----------------------------------------------
    # An address listed and later delisted is absent from today's XML, but the
    # listing was a primary record while it stood. Entity and program are not
    # in the extract history, so they are left empty and the basis says why.
    for (fam, address), hist in history.items():
        if not hist.get("removed_at") or (fam, address) in current_keys:
            continue
        hits = targets(fam, address)
        if not hits:
            continue
        sdn_hits += 1
        earliest, latest = listing_window(hist, "")
        for chain, ledger_addr, via in hits:
            g = grading.grade(
                source_class="ofac_sdn",
                match_basis="address",
                freeze_date=first_freeze[(chain, ledger_addr)],
                record_date=latest,
                record_date_earliest=earliest or UNKNOWN_EARLIEST,
            )
            candidates.append(
                {
                    "address": ledger_addr,
                    "chain": chain,
                    "source_class": "ofac_sdn",
                    "entity": "",
                    "program": "",
                    "record_date": latest,
                    "confidence": g.confidence,
                    "basis": g.basis
                    + f" (SDN asset code {hist['assets']}; {_listed_note(hist, '')}{via}; {REMOVED_MARK} {hist['removed_at']}, so today's SDN file no longer names it or its entity)",
                    "evidence_url": B10C_COMMIT.format(sha=hist["first_commit"]),
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

    # One judgment per record: an address the SDN list names under two asset
    # codes (or two parties sharing a sanctions-search entry) yields two
    # candidates for the same key. Keep the strongest, ties broken by basis, so
    # a re-run picks the same one and writes nothing.
    rank = {"high": 0, "moderate": 1, "low": 2}
    chosen: dict[tuple, dict] = {}
    for c in candidates:
        key = (c["address"], c["chain"], c["source_class"], c["evidence_url"])
        cur = chosen.get(key)
        if cur is None or (rank[c["confidence"]], c["basis"]) < (rank[cur["confidence"]], cur["basis"]):
            chosen[key] = c
    candidates = list(chosen.values())

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
    taken = {r["attribution_id"] for r in existing}
    for c in candidates:
        key = (c["address"], c["chain"], c["source_class"], c["evidence_url"])
        prev = by_key.get(key)
        # same rating, date and reasoning: nothing to re-judge
        if prev and all(prev.get(f, "") == c[f] for f in ("confidence", "record_date", "basis")):
            continue
        aid = _attr_id(*key, c["confidence"], c["record_date"], c["basis"])
        # A judgment can return to one made before (and since superseded); the
        # store skips a known id, which would leave the address with no live
        # row, so a repeat gets a fresh id salted with the date it was judged.
        n = 0
        while aid in taken:
            n += 1
            aid = _attr_id(*key, c["confidence"], c["record_date"], f"{c['basis']}|{today}|{n}")
        taken.add(aid)
        row = {**c, "attribution_id": aid, "judged_at": today, "superseded_by": ""}
        new_rows.append(row)
        if prev:
            superseded[prev["attribution_id"]] = aid
        elif c["evidence_url"] not in independent_urls:
            for ph in placeholders.pop((c["address"], c["chain"], c["source_class"]), []):
                superseded[ph["attribution_id"]] = aid

    # An automatic row (SDN match or the notice linked through it) that the
    # current rules no longer produce is withdrawn, not deleted: a notice for
    # a party's 2010 designation stops being linked to an address added in
    # 2025. Manual rows are only ever replaced by a newer manual judgment.
    candidate_keys = {(c["address"], c["chain"], c["source_class"], c["evidence_url"]) for c in candidates}
    manual_keys = {(r["address"].strip(), r["chain"].strip(), r["source_class"].strip(), (r.get("evidence_url") or "").strip()) for r in manual_rows}
    for key, prev in by_key.items():
        if prev["attribution_id"] in superseded or key in candidate_keys or key in manual_keys:
            continue
        if prev["source_class"] in ("ofac_sdn", "federal_register") and prev["evidence_url"] not in independent_urls:
            superseded[prev["attribution_id"]] = f"{WITHDRAWN}:{today}"

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
