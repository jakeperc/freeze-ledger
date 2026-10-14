import json

import pytest

from freeze_ledger.checkpoint import Checkpoints
from freeze_ledger.receipts import Receipts
from freeze_ledger.store import attribution_store, event_store


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """An empty repo root for data/ and evidence/, selected via FL_ROOT."""
    monkeypatch.setenv("FL_ROOT", str(tmp_path))
    (tmp_path / "data").mkdir()
    (tmp_path / "evidence" / "raw").mkdir(parents=True)
    return tmp_path


class FakeRpc:
    """A JsonRpc stand-in: `handlers[method](params) -> result`. Returns the
    same (result, raw_bytes) shape, counts calls, and records the methods
    called so tests can assert on provider usage."""

    def __init__(self, handlers: dict):
        self.handlers = handlers
        self.calls = 0
        self.active_url = "fake://rpc"
        self.methods: list[tuple[str, list]] = []

    def call(self, method, params=None):
        self.calls += 1
        self.methods.append((method, params or []))
        result = self.handlers[method](params or [])
        raw = json.dumps({"jsonrpc": "2.0", "id": self.calls, "result": result}).encode()
        return result, raw


@pytest.fixture
def stores(repo):
    return Checkpoints(), event_store(), attribution_store(), Receipts()


def quiet(_msg: str) -> None:
    pass
