"""Per-chain cursors, committed to the repo so a run has no state outside git."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import paths


class Checkpoints:
    def __init__(self, path: Path | None = None):
        self.path = path or paths.checkpoints_json()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.data: dict[str, Any] = {}
        if self.path.exists():
            self.data = json.loads(self.path.read_text(encoding="utf-8") or "{}")

    def get(self, chain: str, key: str, default: Any = None) -> Any:
        return self.data.get(chain, {}).get(key, default)

    def set(self, chain: str, key: str, value: Any) -> None:
        self.data.setdefault(chain, {})[key] = value
        self.save()

    def save(self) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        tmp.replace(self.path)
