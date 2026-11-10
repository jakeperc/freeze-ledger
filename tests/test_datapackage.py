"""datapackage.json describes the committed CSVs exactly.

The descriptor is what tools such as frictionless, Kaggle and data portals
read, so a column added, renamed or given a new value must show up here or
this test fails. Standard library only: the checks are the subset of the
Table Schema spec the descriptor uses.
"""

import csv
import json
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PKG = json.loads((ROOT / "datapackage.json").read_text(encoding="utf-8"))
RESOURCES = {r["name"]: r for r in PKG["resources"]}


def _ok(type_: str, v: str) -> bool:
    try:
        if type_ == "integer":
            int(v)
        elif type_ == "number":
            Decimal(v)
        elif type_ == "boolean":
            return v in ("true", "false")
        elif type_ == "date":
            date.fromisoformat(v)
        elif type_ == "datetime":
            datetime.fromisoformat(v.replace("Z", "+00:00"))
        return True
    except (ValueError, InvalidOperation):
        return False


def _rows(res):
    with open(ROOT / res["path"], encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def test_every_data_csv_is_described():
    described = {r["path"] for r in PKG["resources"]}
    published = {f"data/{p.name}" for p in (ROOT / "data").glob("*.csv") if p.name != "attributions_manual.csv"}
    assert published == described


@pytest.mark.parametrize("name", sorted(RESOURCES))
def test_resource_matches_its_csv(name):
    res = RESOURCES[name]
    fields = res["schema"]["fields"]
    header, rows = _rows(res)
    assert header == [f["name"] for f in fields], "column order or names drifted from datapackage.json"
    missing = set(res["schema"].get("missingValues", [""]))
    problems = []
    for f in fields:
        c = f.get("constraints", {})
        values = [r[f["name"]] for r in rows]
        for i, v in enumerate(values):
            if v in missing:
                if c.get("required"):
                    problems.append(f"{f['name']} row {i + 2}: required but empty")
                continue
            if "enum" in c and v not in c["enum"]:
                problems.append(f"{f['name']} row {i + 2}: {v!r} not in {c['enum']}")
            if not _ok(f["type"], v):
                problems.append(f"{f['name']} row {i + 2}: {v!r} is not a {f['type']}")
        if c.get("unique"):
            assert len(set(values)) == len(values), f"{f['name']} has duplicates"
        if len(problems) > 20:
            break
    assert not problems, "\n".join(problems[:20])


def test_foreign_keys_resolve():
    for res in PKG["resources"]:
        for fk in res["schema"].get("foreignKeys", []):
            target = RESOURCES[fk["reference"]["resource"]]
            _, trows = _rows(target)
            keys = {r[fk["reference"]["fields"]] for r in trows}
            _, rows = _rows(res)
            dangling = {r[fk["fields"]] for r in rows} - keys
            assert not dangling, f"{res['name']}.{fk['fields']} has {len(dangling)} ids missing from {target['name']}"
