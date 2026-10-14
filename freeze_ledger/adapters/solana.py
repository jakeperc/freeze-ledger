"""Solana: freezes are Token Program instructions, not events.

A freeze is a `freezeAccount` instruction on a *token account*, signed by the
mint's freeze authority; a thaw is `thawAccount`. The adapter reads the
freeze authority from the mint account on every run (and logs it, so a
rotation is visible), walks that authority's transaction history, and keeps
every instruction whose mint is the one in scope. The frozen thing is a
token account; the owning wallet is resolved from the transaction's token
balances and stored alongside it.

Reads use the `finalized` commitment, so there is no reorg margin to manage.
"""

from __future__ import annotations

import time

from .. import normalize, registry
from ..checkpoint import Checkpoints
from ..http import JsonRpc, RpcError
from ..receipts import Receipts
from ..registry import SolanaMint
from ..store import CsvTable
from .base import Adapter, Log, RunStats, iso_from_unix

SIG_PAGE = 1000
ACTIONS = {"freezeAccount": "freeze", "thawAccount": "unfreeze"}


def parse_freeze_instructions(tx: dict, mint: str) -> list[dict]:
    """Return the freeze/thaw instructions for `mint` found in a jsonParsed
    transaction, each with the token account, its owner (if resolvable from
    the tx balances), the authority, and a stable position index."""
    msg = tx["transaction"]["message"]
    meta = tx.get("meta") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in msg.get("accountKeys", [])]
    owners: dict[str, str] = {}
    for bal in (meta.get("preTokenBalances") or []) + (meta.get("postTokenBalances") or []):
        try:
            owners[keys[bal["accountIndex"]]] = bal.get("owner", "")
        except (IndexError, KeyError):
            continue

    flat: list[tuple[int, dict]] = []
    for i, ix in enumerate(msg.get("instructions", [])):
        flat.append((i * 100, ix))
    for inner in meta.get("innerInstructions") or []:
        base = int(inner.get("index", 0)) * 100
        for j, ix in enumerate(inner.get("instructions", [])):
            flat.append((base + 1 + j, ix))

    out = []
    for pos, ix in flat:
        if ix.get("program") not in ("spl-token", "spl-token-2022"):
            continue
        parsed = ix.get("parsed") or {}
        typ = parsed.get("type")
        if typ not in ACTIONS:
            continue
        info = parsed.get("info") or {}
        if info.get("mint") != mint:
            continue
        account = info.get("account", "")
        out.append(
            {
                "position": pos,
                "action": ACTIONS[typ],
                "account": account,
                "owner": owners.get(account, ""),
                "authority": info.get("freezeAuthority", ""),
            }
        )
    return out


class SolanaAdapter(Adapter):
    chain = "solana"

    def __init__(self, mints: list[SolanaMint] | None = None, rpc: JsonRpc | None = None,
                 call_sleep: float = 0.2):
        self.mints = mints or list(registry.SOLANA_MINTS)
        self.rpc = rpc or JsonRpc(registry.rpc_urls("solana"))
        self.call_sleep = call_sleep

    # --- chain reads ---------------------------------------------------------
    def freeze_authority(self, mint: str) -> str | None:
        result, _ = self.rpc.call("getAccountInfo", [mint, {"encoding": "jsonParsed", "commitment": "finalized"}])
        value = (result or {}).get("value") or {}
        info = (((value.get("data") or {}).get("parsed") or {}).get("info")) or {}
        auth = info.get("freezeAuthority")
        return normalize.solana(auth) if auth else None

    def signatures(self, address: str, before: str | None, until: str | None) -> list[dict]:
        opts: dict = {"limit": SIG_PAGE, "commitment": "finalized"}
        if before:
            opts["before"] = before
        if until:
            opts["until"] = until
        result, _ = self.rpc.call("getSignaturesForAddress", [address, opts])
        return result or []

    def transaction(self, signature: str) -> tuple[dict | None, bytes, str]:
        result, raw = self.rpc.call(
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "finalized"}],
        )
        return result, raw, f"{self.rpc.active_url} getTransaction {signature}"

    def token_account_owner(self, account: str) -> str:
        try:
            result, _ = self.rpc.call("getAccountInfo", [account, {"encoding": "jsonParsed"}])
        except RpcError:
            return ""
        value = (result or {}).get("value") or {}
        info = (((value.get("data") or {}).get("parsed") or {}).get("info")) or {}
        return info.get("owner", "") or ""

    # --- the run -------------------------------------------------------------
    def _process(self, mint: SolanaMint, sigs: list[dict], store: CsvTable, receipts: Receipts,
                 stats: RunStats, log: Log) -> None:
        for s in sorted(sigs, key=lambda x: (x.get("slot", 0), x["signature"])):
            if s.get("err"):
                continue
            tx, raw, locator = self.transaction(s["signature"])
            time.sleep(self.call_sleep)
            if not tx:
                stats.notes.append(f"transaction {s['signature']} not returned")
                continue
            found = parse_freeze_instructions(tx, mint.mint)
            if not found:
                continue
            eid = receipts.record("solana_tx", locator, raw)
            batch = []
            for f in found:
                owner = f["owner"] or self.token_account_owner(f["account"])
                address = normalize.solana(f["account"])
                batch.append(
                    self.make_event(
                        chain=self.chain,
                        issuer=mint.issuer,
                        token=mint.token,
                        action=f["action"],
                        address=address,
                        owner_address=owner,
                        amount="",
                        block_number=int(tx.get("slot") or s.get("slot") or 0),
                        block_time=iso_from_unix(tx.get("blockTime") or s.get("blockTime") or 0),
                        tx_hash=s["signature"],
                        log_index=int(f["position"]),
                        issuer_internal=(address == mint.mint),
                        evidence_id=eid,
                    ).as_row()
                )
            stats.events_seen += len(batch)
            stats.events_new += store.append(batch)

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
        calls_at_start = self.rpc.calls
        for mint in self.mints:
            cp = checkpoints.get(self.chain, mint.mint, {}) or {}
            auth = self.freeze_authority(mint.mint)
            if auth is None:
                stats.notes.append(f"{mint.token}: mint has no freeze authority; nothing to index")
                log(f"[solana] {mint.token}: no freeze authority on mint {mint.mint}")
                continue
            if cp.get("freeze_authority") and cp["freeze_authority"] != auth:
                stats.notes.append(f"{mint.token}: freeze authority changed {cp['freeze_authority']} -> {auth}")
            cp["freeze_authority"] = auth
            cp.setdefault("authority_history", [])
            if auth not in cp["authority_history"]:
                cp["authority_history"].append(auth)
            checkpoints.set(self.chain, mint.mint, cp)
            log(f"[solana] {mint.token}: freeze authority {auth}")

            # 1) forward pass: anything newer than the last processed signature
            newest_known = cp.get("last_signature")
            before = None
            newest_seen: dict | None = None
            while True:
                page = self.signatures(auth, before, newest_known)
                if not page:
                    break
                if newest_seen is None:
                    newest_seen = page[0]
                self._process(mint, page, store, receipts, stats, log)
                before = page[-1]["signature"]
                if len(page) < SIG_PAGE:
                    break
                if newest_known is None and not backfill:
                    stats.notes.append(f"{mint.token}: first run indexed the newest {SIG_PAGE} authority transactions only; run `backfill` for history")
                    break
                if max_calls is not None and self.rpc.calls - calls_at_start >= max_calls:
                    stats.notes.append(f"{mint.token}: call budget reached in forward pass; resume later")
                    break
                time.sleep(self.call_sleep)
            if newest_seen:
                cp["last_signature"] = newest_seen["signature"]
                cp["last_slot"] = newest_seen.get("slot")
                if not cp.get("oldest_signature"):
                    cp["oldest_signature"] = before
                checkpoints.set(self.chain, mint.mint, cp)
            stats.cursor_to = str(cp.get("last_slot", ""))

            # 2) backfill pass: continue walking older history from the oldest
            #    signature seen so far until the authority's history runs out.
            if backfill and not cp.get("backfill_done"):
                before = cp.get("oldest_signature")
                while True:
                    if max_calls is not None and self.rpc.calls - calls_at_start >= max_calls:
                        stats.notes.append(f"{mint.token}: call budget reached in backfill; resume later")
                        break
                    page = self.signatures(auth, before, None)
                    if not page:
                        cp["backfill_done"] = True
                        checkpoints.set(self.chain, mint.mint, cp)
                        stats.notes.append(f"{mint.token}: backfill complete")
                        break
                    self._process(mint, page, store, receipts, stats, log)
                    before = page[-1]["signature"]
                    cp["oldest_signature"] = before
                    cp["oldest_slot"] = page[-1].get("slot")
                    checkpoints.set(self.chain, mint.mint, cp)
                    log(f"[solana] {mint.token}: backfill through slot {page[-1].get('slot')}")
                    if len(page) < SIG_PAGE:
                        cp["backfill_done"] = True
                        checkpoints.set(self.chain, mint.mint, cp)
                        stats.notes.append(f"{mint.token}: backfill complete")
                        break
                    time.sleep(self.call_sleep)
            stats.cursor_from = str(cp.get("oldest_slot", ""))
        stats.calls = self.rpc.calls - calls_at_start
        return stats
