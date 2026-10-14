"""Tron: the USDT TRC-20 contract's blacklist events via TronGrid.

TronGrid's `/v1/contracts/{address}/events` endpoint returns decoded events
by name, paginated by a `fingerprint` cursor. Addresses may arrive in hex or
Base58 depending on the endpoint version; everything is normalized to the
Base58Check "T..." form. Tron carries the largest share of USDT freezes, so
the backfill is long and is designed to be stopped and resumed.
"""

from __future__ import annotations

import time
from decimal import Decimal

from .. import normalize, registry
from ..checkpoint import Checkpoints
from ..http import HttpError, get_json
from ..receipts import Receipts
from ..registry import TronContract
from ..store import CsvTable
from .base import Adapter, Log, RunStats, iso_from_unix

PAGE_SIZE = 200
MARGIN_MS = 5 * 60 * 1000  # re-read window on incremental runs (~100 Tron blocks)
TOKEN_DECIMALS = 6


def _amount(value) -> str:
    units = int(str(value))
    return f"{Decimal(units) / Decimal(10**TOKEN_DECIMALS):.{TOKEN_DECIMALS}f}"


class TronAdapter(Adapter):
    chain = "tron"

    def __init__(self, contracts: list[TronContract] | None = None, base_url: str | None = None,
                 api_key: str | None = None, page_sleep: float = 0.25):
        self.contracts = contracts or list(registry.TRON_CONTRACTS)
        self.base_url = (base_url or registry.TRONGRID_BASE).rstrip("/")
        self.api_key = api_key if api_key is not None else registry.tron_api_key()
        self.page_sleep = page_sleep
        self.calls = 0

    def _headers(self) -> dict:
        h = {"Accept": "application/json"}
        if self.api_key:
            h["TRON-PRO-API-KEY"] = self.api_key
        return h

    def fetch_page(self, contract: str, event_name: str, min_ts: int, fingerprint: str | None):
        url = f"{self.base_url}/v1/contracts/{contract}/events"
        params = {
            "event_name": event_name,
            "only_confirmed": "true",
            "limit": PAGE_SIZE,
            "order_by": "block_timestamp,asc",
            "min_block_timestamp": int(min_ts),
        }
        if fingerprint:
            params["fingerprint"] = fingerprint
        obj, raw = get_json(url, params=params, headers=self._headers())
        self.calls += 1
        if not obj.get("success", True):
            raise RuntimeError(f"TronGrid error: {obj.get('error') or obj}")
        locator = f"{url}?event_name={event_name}&min_block_timestamp={int(min_ts)}&fingerprint={fingerprint or ''}"
        return obj, raw, locator

    def _events(self, contract: TronContract, spec, items: list[dict], evidence_id: str):
        addr_param = spec.params[0][0]
        for it in items:
            if it.get("event_name") != spec.name:
                continue
            res = it.get("result") or {}
            address = normalize.tron(str(res[addr_param]))
            amount = ""
            if spec.action == "destroy":
                amount = _amount(res[spec.params[1][0]])
            ts_ms = int(it["block_timestamp"])
            yield self.make_event(
                chain=self.chain,
                issuer=contract.issuer,
                token=contract.token,
                action=spec.action,
                address=address,
                owner_address="",
                amount=amount,
                block_number=int(it["block_number"]),
                block_time=iso_from_unix(ts_ms // 1000),
                tx_hash=str(it["transaction_id"]).lower(),
                log_index=int(it.get("event_index", 0)),
                issuer_internal=(address == contract.address),
                evidence_id=evidence_id,
            )

    def run(
        self,
        checkpoints: Checkpoints,
        store: CsvTable,
        receipts: Receipts,
        log: Log,
        *,
        backfill: bool = False,
        from_cursor: int | str | None = None,
        to_cursor: int | str | None = None,
        max_calls: int | None = None,
    ) -> RunStats:
        stats = RunStats(chain=self.chain)
        if not self.api_key:
            stats.notes.append("no TronGrid API key (FL_TRON_API_KEY); using the keyless rate limit")
        calls_at_start = self.calls
        now_ms = int(time.time() * 1000)
        to_ms = int(to_cursor) if to_cursor is not None else now_ms
        last_ts_all = checkpoints.get(self.chain, "last_ts", {}) or {}

        for contract in self.contracts:
            for spec in contract.events:
                key = f"{contract.address}:{spec.name}"
                last_ts = last_ts_all.get(key)
                if from_cursor is not None:
                    min_ts = int(from_cursor)
                elif last_ts is not None:
                    min_ts = max(0, int(last_ts) - MARGIN_MS)
                elif backfill:
                    min_ts = 0
                    stats.notes.append(f"backfill {spec.name} from the contract's first event")
                else:
                    min_ts = now_ms - 7 * 24 * 3600 * 1000
                    stats.notes.append(f"no checkpoint for {spec.name}; default lookback 7 days")
                if not stats.cursor_from:
                    stats.cursor_from = str(min_ts)
                stats.cursor_to = str(to_ms)

                fingerprint: str | None = None
                pages = 0
                newest_ts = int(last_ts) if last_ts else 0
                log(f"[tron] {contract.token} {spec.name}: from {iso_from_unix(min_ts // 1000)}")
                while True:
                    try:
                        obj, raw, locator = self.fetch_page(contract.address, spec.name, min_ts, fingerprint)
                    except HttpError as e:
                        if e.status == 429:
                            log("[tron] rate limited; sleeping 10s")
                            time.sleep(10)
                            continue
                        raise
                    items = [i for i in (obj.get("data") or []) if int(i["block_timestamp"]) <= to_ms]
                    pages += 1
                    if items:
                        eid = receipts.record("trongrid_event", locator, raw)
                        batch = [ev.as_row() for ev in self._events(contract, spec, items, eid)]
                        stats.events_seen += len(batch)
                        stats.events_new += store.append(batch)
                        newest_ts = max(newest_ts, max(int(i["block_timestamp"]) for i in items))
                        last_ts_all[key] = newest_ts
                        checkpoints.set(self.chain, "last_ts", last_ts_all)
                        log(f"[tron] {spec.name} page {pages}: {len(batch)} events, through {iso_from_unix(newest_ts // 1000)}")
                    meta = obj.get("meta") or {}
                    fingerprint = meta.get("fingerprint")
                    has_next = bool(fingerprint) and bool((meta.get("links") or {}).get("next"))
                    if not has_next or not items:
                        break
                    if max_calls is not None and self.calls - calls_at_start >= max_calls:
                        stats.notes.append(f"stopped {spec.name} after {max_calls} calls; resume later")
                        break
                    time.sleep(self.page_sleep)
                if last_ts is None and newest_ts == 0:
                    # nothing found in window: still record that we looked
                    last_ts_all[key] = to_ms
                    checkpoints.set(self.chain, "last_ts", last_ts_all)
        stats.calls = self.calls - calls_at_start
        return stats
