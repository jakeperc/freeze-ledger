"""OFAC SDN list: extract every digital-currency address with its entity,
program(s) and listing date from `sdn_advanced.xml`.

The advanced XML is large (hundreds of MB) and deeply cross-referenced, so it
is streamed with iterparse and only four things are kept:

- ReferenceValueSets: feature-type and sanctions-type/program names by id
- DistinctParty: the party's FixedRef, its primary name, and every
  `Digital Currency Address - <ASSET>` feature value
- SanctionsEntry: the party's earliest entry date and its program codes

Nothing is inferred: asset code, address, name, program and date are copied
as the file states them. The parser is validated against a fixture in
tests/; on the first real run, spot-check ten rows against
https://sanctionssearch.ofac.treas.gov/ as METHODOLOGY.md says.
"""

from __future__ import annotations

import csv
import hashlib
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from .. import normalize, paths, registry

DIGITAL_PREFIX = "Digital Currency Address - "

SDN_COLUMNS = [
    "asset",
    "address",
    "address_norm",
    "chain_hint",
    "entity",
    "program",
    "listed_date",
    "fixed_ref",
    "feature_id",
]


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


@dataclass
class Party:
    fixed_ref: str
    name: str = ""
    addresses: list[tuple[str, str, str]] = field(default_factory=list)  # (asset, address, feature_id)


@dataclass
class Entry:
    profile_id: str
    programs: list[str] = field(default_factory=list)
    dates: list[str] = field(default_factory=list)


def chain_hint(asset: str, address: str) -> str:
    """Best-effort mapping from the SDN asset code and address shape to the
    chains in scope. 'other' is kept, never dropped."""
    a = address.strip()
    if a.startswith("0x") and len(a) == 42:
        return "evm"
    if asset in ("TRX",) or (a.startswith("T") and len(a) == 34):
        return "tron"
    if asset in ("SOL",):
        return "solana"
    if asset in ("XBT", "BTC"):
        return "bitcoin"
    if asset in ("USDT", "USDC"):
        # format already failed the EVM/Tron shape tests above
        try:
            normalize.solana(a)
            return "solana"
        except ValueError:
            return "other"
    return "other"


def normalize_for_hint(hint: str, address: str) -> str:
    try:
        if hint == "evm":
            return normalize.evm(address)
        if hint == "tron":
            return normalize.tron(address)
        if hint == "solana":
            return normalize.solana(address)
    except ValueError:
        return address.strip()
    return address.strip()


def parse_sdn_advanced(source) -> list[dict]:
    """Parse sdn_advanced.xml (path or file object) into SDN_COLUMNS rows."""
    feature_types: dict[str, str] = {}
    sanctions_types: dict[str, str] = {}
    parties: dict[str, Party] = {}
    entries: dict[str, Entry] = {}

    # iterparse with start events so we can clear finished subtrees
    for event, elem in ET.iterparse(source, events=("end",)):
        tag = _local(elem.tag)
        if tag == "FeatureType":
            feature_types[elem.get("ID", "")] = (elem.text or "").strip()
        elif tag == "SanctionsType":
            sanctions_types[elem.get("ID", "")] = (elem.text or "").strip()
        elif tag == "DistinctParty":
            party = Party(fixed_ref=elem.get("FixedRef", ""))
            for child in elem.iter():
                ct = _local(child.tag)
                if ct == "Identity" and not party.name and child.get("Primary", "false") == "true":
                    party.name = _primary_name(child)
                elif ct == "Feature":
                    ftype = feature_types.get(child.get("FeatureTypeID", ""), "")
                    if ftype.startswith(DIGITAL_PREFIX):
                        asset = ftype[len(DIGITAL_PREFIX):].strip()
                        for vd in child.iter():
                            if _local(vd.tag) == "VersionDetail" and (vd.text or "").strip():
                                party.addresses.append((asset, vd.text.strip(), child.get("ID", "")))
            if not party.name:
                # fall back to any identity
                for child in elem.iter():
                    if _local(child.tag) == "Identity":
                        party.name = _primary_name(child)
                        if party.name:
                            break
            if party.addresses:
                parties[party.fixed_ref] = party
            elem.clear()
        elif tag == "SanctionsEntry":
            entry = Entry(profile_id=elem.get("ProfileID", ""))
            for child in elem.iter():
                ct = _local(child.tag)
                if ct == "EntryEvent":
                    d = _date_of(child)
                    if d:
                        entry.dates.append(d)
                elif ct == "SanctionsMeasure":
                    stype = sanctions_types.get(child.get("SanctionsTypeID", ""), "")
                    if stype.lower() == "program":
                        for c2 in child.iter():
                            if _local(c2.tag) == "Comment" and (c2.text or "").strip():
                                entry.programs.append(c2.text.strip())
            if entry.profile_id in entries:
                entries[entry.profile_id].programs.extend(entry.programs)
                entries[entry.profile_id].dates.extend(entry.dates)
            else:
                entries[entry.profile_id] = entry
            elem.clear()

    rows: list[dict] = []
    for fixed_ref, party in parties.items():
        entry = entries.get(fixed_ref)
        programs = sorted(set(entry.programs)) if entry else []
        listed = min(entry.dates) if entry and entry.dates else ""
        for asset, address, feature_id in party.addresses:
            hint = chain_hint(asset, address)
            rows.append(
                {
                    "asset": asset,
                    "address": address,
                    "address_norm": normalize_for_hint(hint, address),
                    "chain_hint": hint,
                    "entity": party.name,
                    "program": ";".join(programs),
                    "listed_date": listed,
                    "fixed_ref": fixed_ref,
                    "feature_id": feature_id,
                }
            )
    rows.sort(key=lambda r: (r["asset"], r["entity"], r["address"]))
    return rows


def _primary_name(identity) -> str:
    """Join the name parts of the primary alias of an Identity element."""
    best = ""
    for alias in identity.iter():
        if _local(alias.tag) != "Alias":
            continue
        parts = [
            (npv.text or "").strip()
            for npv in alias.iter()
            if _local(npv.tag) == "NamePartValue" and (npv.text or "").strip()
        ]
        name = " ".join(parts)
        if alias.get("Primary", "false") == "true" and name:
            return name
        if name and not best:
            best = name
    return best


def _date_of(entry_event) -> str:
    y = m = d = ""
    for el in entry_event.iter():
        t = _local(el.tag)
        if t == "Year":
            y = (el.text or "").strip()
        elif t == "Month":
            m = (el.text or "").strip()
        elif t == "Day":
            d = (el.text or "").strip()
    if y and m and d:
        return f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    return ""


def write_sdn_csv(rows: Iterable[dict], path: Path | None = None) -> Path:
    path = path or paths.sdn_addresses_csv()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=SDN_COLUMNS)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    return path


def read_sdn_csv(path: Path | None = None) -> list[dict]:
    path = path or paths.sdn_addresses_csv()
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def download_and_parse(dest_xml: Path, log=print) -> tuple[list[dict], str, int]:
    """Download sdn_advanced.xml to `dest_xml`, return (rows, sha256, size)."""
    from ..http import get_bytes

    log(f"[sdn] downloading {registry.SDN_ADVANCED_XML} ...")
    raw = get_bytes(registry.SDN_ADVANCED_XML, timeout=600, retries=3)
    dest_xml.parent.mkdir(parents=True, exist_ok=True)
    dest_xml.write_bytes(raw)
    sha = hashlib.sha256(raw).hexdigest()
    log(f"[sdn] {len(raw):,} bytes, sha256 {sha[:16]}...; parsing")
    rows = parse_sdn_advanced(str(dest_xml))
    log(f"[sdn] {len(rows)} digital-currency address rows across {len({r['fixed_ref'] for r in rows})} parties")
    return rows, sha, len(raw)
