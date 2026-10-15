"""Ethereum and Base: `eth_getLogs` over the issuer contracts, decoded by ABI.

Tether's contract emits its blacklist events with no indexed parameters
(the address sits in `data`); Circle's FiatToken indexes the account (it sits
in `topics[1]`). The decoder is driven by the EventSpec in registry.py so the
same code path serves both.
"""

from __future__ import annotations

import time
from decimal import Decimal

from .. import normalize, registry
from ..checkpoint import Checkpoints
from ..http import HttpError, JsonRpc, RpcError
from ..receipts import Receipts
from ..registry import EventSpec, EvmContract
from ..store import CsvTable
from .base import Adapter, Log, RunStats, iso_from_unix

TOKEN_DECIMALS = 6  # USDT and USDC on every chain in scope
DEFAULT_LOOKBACK_BLOCKS = {"ethereum": 50_400, "base": 302_400}  # about 7 days
CONFIRMATIONS = 12

_RANGE_ERRORS = ("more than", "too many", "limit", "range", "exceed", "block range", "response size")


def _hex(n: int) -> str:
    return hex(n)


def _word_to_address(word: str) -> str:
    return normalize.evm(word)


def _word_to_uint(word: str) -> int:
    w = word.lower()
    if w.startswith("0x"):
        w = w[2:]
    return int(w or "0", 16)


def decode_log(log: dict, spec: EventSpec) -> dict:
    """Decode one `eth_getLogs` entry against its EventSpec. Returns the
    decoded parameters by name."""
    topics = log.get("topics", [])
    data = log.get("data", "0x")
    if data.startswith("0x"):
        data = data[2:]
    words = [data[i : i + 64] for i in range(0, len(data), 64)]
    out: dict = {}
    topic_i = 1
    word_i = 0
    for name, typ, indexed in spec.params:
        if indexed:
            raw = topics[topic_i]
            topic_i += 1
        else:
            raw = words[word_i]
            word_i += 1
        if typ == "address":
            out[name] = _word_to_address(raw)
        elif typ.startswith("uint"):
            out[name] = _word_to_uint(raw)
        else:
            raise ValueError(f"unsupported ABI type {typ}")
    return out


def format_amount(units: int, decimals: int = TOKEN_DECIMALS) -> str:
    q = Decimal(units) / (Decimal(10) ** decimals)
    return f"{q:.{decimals}f}"


class EvmAdapter(Adapter):
    def __init__(
        self,
        chain: str,
        contracts: list[EvmContract] | None = None,
        rpc: JsonRpc | None = None,
        chunk: int = 2_000,
        min_chunk: int = 50,
        max_chunk: int = 10_000,
    ):
        self.chain = chain
        self.contracts = contracts or [c for c in registry.EVM_CONTRACTS if c.chain == chain]
        if not self.contracts:
            raise ValueError(f"no EVM contracts registered for {chain}")
        self.rpc = rpc or JsonRpc(registry.rpc_urls(chain))
        # A second, independent endpoint used to re-count any chunk that
        # returned events; None when only one endpoint is configured.
        self.cross_rpc: JsonRpc | None = None
        if rpc is None and len(registry.rpc_urls(chain)) > 1:
            self.cross_rpc = JsonRpc(registry.rpc_urls(chain)[1:])
        self.chunk = chunk
        self.min_chunk = min_chunk
        self.max_chunk = max_chunk
        self._block_time_cache: dict[int, str] = {}
        # topic0 -> (contract, spec)
        self._by_topic: dict[str, tuple[EvmContract, EventSpec]] = {}
        for c in self.contracts:
            for s in c.events:
                self._by_topic[s.topic0] = (c, s)
        self._addresses = [c.address.lower() for c in self.contracts]
        self._by_address = {c.address.lower(): c for c in self.contracts}

    # --- chain reads ---------------------------------------------------------
    def head(self) -> int:
        result, _ = self.rpc.call("eth_blockNumber")
        return int(result, 16)

    def code_exists_at(self, address: str, block: int) -> bool:
        result, _ = self.rpc.call("eth_getCode", [address, _hex(block)])
        return bool(result) and result not in ("0x", "0x0")

    def find_deployment_block(self, address: str, head: int | None = None) -> int:
        """Binary-search the first block where the contract has code. Costs
        about log2(head) calls and replaces a hand-copied number."""
        hi = head if head is not None else self.head()
        if not self.code_exists_at(address, hi):
            raise RuntimeError(f"{address} has no code at head block {hi} on {self.chain}")
        lo = 0
        while lo < hi:
            mid = (lo + hi) // 2
            if self.code_exists_at(address, mid):
                hi = mid
            else:
                lo = mid + 1
        return lo

    def block_time(self, block_number: int) -> str:
        if block_number in self._block_time_cache:
            return self._block_time_cache[block_number]
        result, _ = self.rpc.call("eth_getBlockByNumber", [_hex(block_number), False])
        if not result:
            raise RuntimeError(f"block {block_number} not returned by {self.rpc.active_url}")
        ts = iso_from_unix(int(result["timestamp"], 16))
        self._block_time_cache[block_number] = ts
        return ts

    def get_logs(self, from_block: int, to_block: int) -> tuple[list[dict], bytes, str]:
        params = [
            {
                "fromBlock": _hex(from_block),
                "toBlock": _hex(to_block),
                "address": self._addresses if len(self._addresses) > 1 else self._addresses[0],
                "topics": [list(self._by_topic.keys())],
            }
        ]
        result, raw = self.rpc.call("eth_getLogs", params)
        locator = f"{self.rpc.active_url} eth_getLogs {from_block}-{to_block} {','.join(self._addresses)}"
        return result or [], raw, locator

    def get_logs_adaptive(self, from_block: int, to_block: int, log: Log):
        """Yield (chunk_from, chunk_to, logs, raw, locator), shrinking the chunk
        on provider range errors and growing it back on success."""
        cur = from_block
        while cur <= to_block:
            end = min(cur + self.chunk - 1, to_block)
            try:
                logs, raw, locator = self.get_logs(cur, end)
            except RpcError as e:
                msg = (e.message or "").lower()
                if self.chunk > self.min_chunk and (any(k in msg for k in _RANGE_ERRORS) or e.code in (-32005, -32602, -32000)):
                    self.chunk = max(self.min_chunk, self.chunk // 2)
                    log(f"[{self.chain}] provider rejected range ({e.message}); chunk -> {self.chunk}")
                    continue
                raise
            except HttpError as e:
                if e.status == 429 and self.chunk > self.min_chunk:
                    self.chunk = max(self.min_chunk, self.chunk // 2)
                    log(f"[{self.chain}] rate limited; chunk -> {self.chunk}, sleeping")
                    time.sleep(5)
                    continue
                raise
            yield cur, end, logs, raw, locator
            cur = end + 1
            if len(logs) < 500 and self.chunk < self.max_chunk:
                self.chunk = min(self.max_chunk, self.chunk * 2)

    # --- the run -------------------------------------------------------------
    def _events_from_logs(self, logs: list[dict], evidence_id: str):
        for lg in logs:
            if lg.get("removed"):
                continue
            topic0 = (lg.get("topics") or [""])[0].lower()
            hit = self._by_topic.get(topic0)
            if not hit:
                continue
            contract, spec = hit
            if lg.get("address", "").lower() != contract.address.lower():
                # same topic emitted by the other contract on this chain (it
                # cannot happen for these two ABIs, but stay exact)
                contract = self._by_address.get(lg.get("address", "").lower(), contract)
            decoded = decode_log(lg, spec)
            addr_param = spec.params[0][0]
            address = decoded[addr_param]
            amount = ""
            if spec.action == "destroy":
                amount = format_amount(decoded[spec.params[1][0]])
            block_number = int(lg["blockNumber"], 16)
            yield self.make_event(
                chain=self.chain,
                issuer=contract.issuer,
                token=contract.token,
                action=spec.action,
                address=address,
                owner_address="",
                amount=amount,
                block_number=block_number,
                block_time=self.block_time(block_number),
                tx_hash=lg["transactionHash"].lower(),
                log_index=int(lg["logIndex"], 16),
                issuer_internal=(address == contract.address.lower()),
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
        head = self.head()
        safe_head = head - CONFIRMATIONS
        last = checkpoints.get(self.chain, "last_block")

        if from_cursor is not None:
            start = int(from_cursor)
        elif backfill:
            # A backfill always walks from the contracts' deployment block (or
            # its own resumable cursor), whatever the forward checkpoint says,
            # so a bootstrap that started mid-history can be completed later.
            resume = checkpoints.get(self.chain, "backfill_cursor")
            if resume is not None and not checkpoints.get(self.chain, "backfill_done"):
                start = int(resume) + 1
                stats.notes.append(f"backfill resumed at block {start}")
            else:
                deployments = checkpoints.get(self.chain, "deployment_block", {}) or {}
                for c in self.contracts:
                    if c.address.lower() not in deployments:
                        log(f"[{self.chain}] locating deployment block of {c.token} {c.address} ...")
                        deployments[c.address.lower()] = self.find_deployment_block(c.address, head)
                        checkpoints.set(self.chain, "deployment_block", deployments)
                        log(f"[{self.chain}] {c.token} first has code at block {deployments[c.address.lower()]}")
                start = min(deployments[c.address.lower()] for c in self.contracts)
                stats.notes.append(f"backfill from deployment block {start}")
        elif last is not None:
            start = max(0, int(last) - registry.REORG_MARGIN[self.chain] + 1)
        else:
            start = max(0, safe_head - DEFAULT_LOOKBACK_BLOCKS[self.chain])
            stats.notes.append(f"no checkpoint; default lookback from block {start}")

        end = int(to_cursor) if to_cursor is not None else safe_head
        stats.cursor_from, stats.cursor_to = str(start), str(end)
        if start > end:
            log(f"[{self.chain}] nothing to do: start {start} > end {end}")
            return stats

        log(f"[{self.chain}] indexing blocks {start}..{end} ({end - start + 1} blocks) via {self.rpc.active_url}")
        calls_at_start = self.rpc.calls
        seen_in_margin: set[str] = set()
        margin_lo = start if last is not None else None

        for c_from, c_to, logs, raw, locator in self.get_logs_adaptive(start, end, log):
            if logs and self.cross_rpc is not None:
                # Re-count the chunk on an independent endpoint. A mismatch is
                # re-fetched once from the primary; if it persists, the primary
                # result is stored and the discrepancy is logged for verify.py.
                try:
                    other, _ = self.cross_rpc.call("eth_getLogs", [{
                        "fromBlock": _hex(c_from), "toBlock": _hex(c_to),
                        "address": self._addresses if len(self._addresses) > 1 else self._addresses[0],
                        "topics": [list(self._by_topic.keys())],
                    }])
                    if len(other or []) != len(logs):
                        logs2, raw2, locator2 = self.get_logs(c_from, c_to)
                        if len(logs2) != len(logs):
                            logs, raw, locator = logs2, raw2, locator2
                        if len(other or []) != len(logs):
                            stats.notes.append(
                                f"PROVIDER MISMATCH {c_from}-{c_to}: primary {len(logs)} logs vs {self.cross_rpc.active_url} {len(other or [])}"
                            )
                            log(f"[{self.chain}] provider mismatch on {c_from}-{c_to}; stored primary result, flagged")
                except (RpcError, HttpError) as e:
                    stats.notes.append(f"cross-check unavailable for {c_from}-{c_to}: {e}")
            if logs:
                eid = receipts.record("rpc_log", locator, raw)
                batch = [ev.as_row() for ev in self._events_from_logs(logs, eid)]
                stats.events_seen += len(batch)
                stats.events_new += store.append(batch)
                if margin_lo is not None:
                    seen_in_margin.update(r["event_id"] for r in batch if int(r["block_number"]) <= int(last))
                log(f"[{self.chain}] {c_from}..{c_to}: {len(batch)} events ({stats.events_new} new so far)")
            if backfill:
                checkpoints.set(self.chain, "backfill_cursor", c_to)
                if c_to >= end:
                    checkpoints.set(self.chain, "backfill_done", True)
            checkpoints.set(self.chain, "last_block", max(c_to, int(last) if last is not None else 0))
            if max_calls is not None and self.rpc.calls - calls_at_start >= max_calls:
                stats.notes.append(f"stopped at block {c_to} after {max_calls} calls; resume later")
                log(f"[{self.chain}] call budget reached at block {c_to}")
                break

        if margin_lo is not None and last is not None:
            # Any stored event inside the re-read margin that the chain no
            # longer returns is a candidate removed log. It is reported, never
            # silently deleted (see CHANGELOG policy). A backfill that stops
            # below the checkpoint only re-read up to its own end.
            margin_hi = min(int(last), end)
            stored = [
                r["event_id"]
                for r in store.rows()
                if r["chain"] == self.chain and margin_lo <= int(r["block_number"]) <= margin_hi
            ]
            missing = sorted(set(stored) - seen_in_margin)
            if missing:
                stats.notes.append(f"REORG CHECK: {len(missing)} stored event(s) not returned on re-read: {missing[:5]}")
        stats.calls = self.rpc.calls - calls_at_start
        return stats
