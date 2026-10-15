"""Minimal HTTP and JSON-RPC client on the standard library, with retries.

Returns the raw response bytes alongside the parsed JSON so callers can hash
and keep the exact bytes a row was derived from.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

USER_AGENT = "freeze-ledger/0.1 (+https://github.com/jakeperc/freeze-ledger)"


class HttpError(Exception):
    def __init__(self, status: int | None, message: str, url: str):
        super().__init__(f"{status}: {message} ({url})")
        self.status = status
        self.url = url


class RpcError(Exception):
    def __init__(self, code: Any, message: str, method: str):
        super().__init__(f"rpc {method} failed: {code} {message}")
        self.code = code
        self.message = message
        self.method = method


def _request(
    url: str,
    data: bytes | None,
    headers: dict[str, str],
    timeout: float,
    retries: int,
) -> bytes:
    last: Exception | None = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **headers})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:  # 4xx/5xx
            body = e.read()[:300].decode("utf-8", "replace")
            last = HttpError(e.code, body, url)
            retryable = e.code in (408, 425, 429, 500, 502, 503, 504)
            if not retryable:
                raise last
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = HttpError(None, str(e), url)
        if attempt < retries:
            time.sleep(min(30.0, (2**attempt) * 0.5 + random.random() * 0.5))
    assert last is not None
    raise last


def get_bytes(url: str, params: dict | None = None, headers: dict | None = None,
              timeout: float = 60, retries: int = 5) -> bytes:
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params, doseq=True)
    return _request(url, None, headers or {}, timeout, retries)


def get_json(url: str, params: dict | None = None, headers: dict | None = None,
             timeout: float = 60, retries: int = 5) -> tuple[Any, bytes]:
    raw = get_bytes(url, params, headers, timeout, retries)
    return json.loads(raw), raw


class JsonRpc:
    """JSON-RPC 2.0 over HTTP with endpoint fallback and bounded retries."""

    def __init__(self, urls: list[str], timeout: float = 60, retries: int = 3):
        if not urls:
            raise ValueError("at least one RPC url is required")
        self.urls = list(urls)
        self.timeout = timeout
        self.retries = retries
        self._id = 0
        self.calls = 0
        self.active_url = self.urls[0]

    def call(self, method: str, params: list | None = None) -> tuple[Any, bytes]:
        """Return (result, raw_response_bytes). Rotates to the next endpoint on
        transport failure; raises RpcError on a JSON-RPC error object."""
        self._id += 1
        payload = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params or []}).encode()
        headers = {"Content-Type": "application/json"}
        last: Exception | None = None
        for i in range(len(self.urls)):
            url = self.urls[(self.urls.index(self.active_url) + i) % len(self.urls)]
            try:
                raw = _request(url, payload, headers, self.timeout, self.retries)
                self.calls += 1
                self.active_url = url
                obj = json.loads(raw)
                if "error" in obj and obj["error"]:
                    err = obj["error"]
                    raise RpcError(err.get("code"), err.get("message", ""), method)
                return obj.get("result"), raw
            except HttpError as e:
                last = e
                continue
        assert last is not None
        raise last
