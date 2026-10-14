"""Federal Register: find the OFAC designation notice for an entity near its
SDN listing date, so an attribution can link to the dated primary notice
rather than only to the sanctions-search record.

Network use is optional (`attribute --no-federal-register`); results are
cached in data/federal_register_cache.json so re-runs do not re-query.
"""

from __future__ import annotations

import json
from datetime import date, timedelta
from pathlib import Path

from .. import paths, registry
from ..http import HttpError, get_json

OFAC_AGENCY_SLUG = "foreign-assets-control-office"
WINDOW_DAYS = 45


def _cache_path() -> Path:
    return paths.data_dir() / "federal_register_cache.json"


def _load_cache() -> dict:
    p = _cache_path()
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8") or "{}")
    return {}


def _save_cache(cache: dict) -> None:
    p = _cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def find_notice(entity: str, listed_date: str, log=print) -> dict | None:
    """Return {'title','publication_date','html_url','document_number'} for
    the closest OFAC notice mentioning `entity` within WINDOW_DAYS of
    `listed_date`, or None."""
    if not entity or not listed_date:
        return None
    key = f"{entity}|{listed_date}"
    cache = _load_cache()
    if key in cache:
        return cache[key] or None
    try:
        d = date.fromisoformat(listed_date[:10])
    except ValueError:
        return None
    params = {
        "conditions[agencies][]": OFAC_AGENCY_SLUG,
        "conditions[term]": f'"{entity}"',
        "conditions[publication_date][gte]": (d - timedelta(days=WINDOW_DAYS)).isoformat(),
        "conditions[publication_date][lte]": (d + timedelta(days=WINDOW_DAYS)).isoformat(),
        "order": "relevance",
        "per_page": 5,
        "fields[]": ["title", "publication_date", "html_url", "document_number"],
    }
    try:
        obj, _ = get_json(registry.FEDERAL_REGISTER_API, params=params, timeout=60, retries=2)
    except HttpError as e:
        log(f"[federal-register] lookup failed for {entity!r}: {e}")
        return None
    results = obj.get("results") or []
    best = None
    for r in results:
        try:
            pd = date.fromisoformat(r.get("publication_date", "")[:10])
        except ValueError:
            continue
        gap = abs((pd - d).days)
        if best is None or gap < best[0]:
            best = (gap, r)
    found = None
    if best:
        r = best[1]
        found = {
            "title": r.get("title", ""),
            "publication_date": r.get("publication_date", ""),
            "html_url": r.get("html_url", ""),
            "document_number": r.get("document_number", ""),
        }
    cache[key] = found
    _save_cache(cache)
    return found
