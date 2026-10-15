"""Independent SDN address extract (0xB10C's nightly lists) as a fallback
source of `sdn_addresses.csv` rows when `sdn_advanced.xml` cannot be fetched.

These rows carry the address and the SDN asset code only: no entity, program
or listing date. The join still grades them (exact address in the OFAC list
is a primary fact) but every basis string says the entity and date are
pending the full XML parse, and the real `sdn` run adds the complete rows
alongside these.
"""

from __future__ import annotations

from .. import normalize, registry
from ..http import get_json
from .sdn import chain_hint, normalize_for_hint


def fetch_rows(log=print) -> list[dict]:
    rows: list[dict] = []
    for asset, url in registry.B10C_LISTS.items():
        lst, _ = get_json(url, timeout=60, retries=2)
        n = 0
        for a in lst:
            a = str(a).strip()
            if not a:
                continue
            hint = chain_hint(asset, a)
            rows.append(
                {
                    "asset": asset,
                    "address": a,
                    "address_norm": normalize_for_hint(hint, a),
                    "chain_hint": hint,
                    "entity": "",
                    "program": "",
                    "listed_date": "",
                    "fixed_ref": "",
                    "feature_id": "",
                    "source_url": url,
                }
            )
            n += 1
        log(f"[sdn:independent] {asset}: {n} addresses from {url}")
    return rows
