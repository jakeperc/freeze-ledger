"""Where files live. The repo root is the directory holding pyproject.toml;
override with FL_ROOT for tests and ad-hoc runs."""

from __future__ import annotations

import os
from pathlib import Path


def root() -> Path:
    env = os.environ.get("FL_ROOT")
    if env:
        return Path(env).resolve()
    here = Path(__file__).resolve().parent.parent
    return here


def data_dir() -> Path:
    return root() / "data"


def evidence_dir() -> Path:
    return root() / "evidence"


def events_csv() -> Path:
    return data_dir() / "freeze_events.csv"


def attributions_csv() -> Path:
    return data_dir() / "attributions.csv"


def manual_attributions_csv() -> Path:
    return data_dir() / "attributions_manual.csv"


def evidence_csv() -> Path:
    return data_dir() / "evidence.csv"


def checkpoints_json() -> Path:
    return data_dir() / "checkpoints.json"


def latest_json() -> Path:
    return data_dir() / "latest.json"


def sdn_addresses_csv() -> Path:
    return data_dir() / "sdn_addresses.csv"


def ensure_dirs() -> None:
    data_dir().mkdir(parents=True, exist_ok=True)
    (evidence_dir() / "raw").mkdir(parents=True, exist_ok=True)
