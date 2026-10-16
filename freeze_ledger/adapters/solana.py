"""Solana: freezes are Token Program instructions, not events.

A freeze is a `freezeAccount` instruction on a *token account*, signed by the
mint's freeze authority; a thaw is `thawAccount`. The adapter reads the
freeze authority from the mint account on every run (and logs it, so a
rotation is visible), walks the transaction history of that authority and of
every earlier one in the checkpoint's `authority_history` (seeded from the
registry, since an old authority cannot be read back from the mint), and keeps
every instruction whose mint is the one in scope. The frozen thing is a
token account; the owning wallet is resolved from the transaction's token
balances and stored alongside it.

Reads use the `finalized` commitment, so there is no reorg margin to manage.
"""

from __future__ import annotations

import time

from .. import normalize, registry
from ..checkpoint import Checkpoints
from ..http import HttpError, JsonRpc, RpcError
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
                # a multisig authority is reported under its own key
                "authority": info.get("freezeAuthority") or info.get("multisigFreezeAuthority", ""),
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
        result, _ = self._history_call("getSignaturesForAddress", [address, opts])
        return result or []

    def transaction(self, signature: str) -> tuple[dict | None, bytes, str]:
        result, raw = self._history_call(
            "getTransaction",
            [signature, {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0, "commitment": "finalized"}],
        )
        return result, raw, f"{self.rpc.active_url} getTransaction {signature}"

    def _history_call(self, method: str, params: list) -> tuple:
        """Call `method` on each endpoint in order until one returns a
        non-empty result. Public endpoints prune history at different depths:
        a pruned one answers `null`, an empty page, or "not found" for a
        `before` signature it no longer holds, all of which mean "not served
        here" rather than "nothing there". The first endpoint is tried first on
        every call, so a fallback after a rate limit does not stick."""
        urls = list(getattr(self.rpc, "urls", None) or [None])
        result, raw, error = None, b"", None
        for url in urls:
            if url is not None:
                self.rpc.active_url = url
            try:
                result, raw = self.rpc.call(method, params)
            except (RpcError, HttpError) as e:
                error = e
                continue
            if result:
                return result, raw
        if error is not None and not raw:
            raise error
        return result, raw

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
                 stats: RunStats, log: Log) -> int:
        """Index the freezes in `sigs`; return how many transactions no
        endpoint returned (a page with any is not complete)."""
        missing = 0
        for s in sorted(sigs, key=lambda x: (x.get("slot", 0), x["signature"])):
            if s.get("err"):
                continue
            tx, raw, locator = self.transaction(s["signature"])
            time.sleep(self.call_sleep)
            if not tx:
                stats.notes.append(f"transaction {s['signature']} not returned")
                missing += 1
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
        return missing

    # Cursor keys kept per authority. The current authority's sit at the top
    # level of the mint's checkpoint (the original layout); an earlier
    # authority's sit under `authorities[<address>]`.
    CURSOR_KEYS = ("last_signature", "last_slot", "oldest_signature", "oldest_slot", "backfill_done")

    def _walk(self, mint: SolanaMint, auth: str, state: dict, save, store: CsvTable, receipts: Receipts,
              stats: RunStats, log: Log, *, backfill: bool, budget_left) -> bool:
        """Walk one authority's signature history: a forward pass down to the
        last signature already processed, then (when backfilling) older pages
        below the oldest one seen. `state` holds that authority's cursors and
        `save()` persists them. Returns True when both passes ran to the end."""
        complete = True
        # 1) forward pass: anything newer than the last processed signature
        newest_known = state.get("last_signature")
        before = None
        before_slot = None
        newest_seen: dict | None = None
        reached_bottom = False
        while True:
            page = self.signatures(auth, before, newest_known)
            if not page or len(page) < SIG_PAGE:
                # with no cursor, a short page is the start of the history:
                # nothing is left for the backfill pass (and asking the RPC for
                # signatures before the very first one fails on pruning nodes)
                reached_bottom = newest_known is None
            if not page:
                break
            if newest_seen is None:
                newest_seen = page[0]
            if self._process(mint, page, store, receipts, stats, log):
                # cursors stay where they were, so the next run reads this
                # stretch again rather than stepping over a transaction no
                # endpoint returned
                stats.notes.append(f"{mint.token}: {auth} has unreadable transactions; cursors not advanced")
                return False
            before, before_slot = page[-1]["signature"], page[-1].get("slot")
            if len(page) < SIG_PAGE:
                break
            if newest_known is None and not backfill:
                stats.notes.append(f"{mint.token}: first run indexed the newest {SIG_PAGE} transactions of {auth} only; run `backfill` for history")
                complete = False
                break
            if not budget_left():
                stats.notes.append(f"{mint.token}: call budget reached in forward pass of {auth}; resume later")
                complete = False
                break
            time.sleep(self.call_sleep)
        if newest_seen:
            state["last_signature"] = newest_seen["signature"]
            state["last_slot"] = newest_seen.get("slot")
            if not state.get("oldest_signature"):
                state["oldest_signature"], state["oldest_slot"] = before, before_slot
        if reached_bottom and not state.get("backfill_done"):
            state["backfill_done"] = True
            stats.notes.append(f"{mint.token}: history of {auth} walked to its first transaction")
        if newest_seen or reached_bottom:
            save()

        # 2) backfill pass: continue walking older history from the oldest
        #    signature seen so far until the authority's history runs out.
        if backfill and not state.get("backfill_done"):
            before = state.get("oldest_signature")
            while True:
                if not budget_left():
                    stats.notes.append(f"{mint.token}: call budget reached in backfill of {auth}; resume later")
                    return False
                page = self.signatures(auth, before, None)
                if page:
                    if self._process(mint, page, store, receipts, stats, log):
                        stats.notes.append(f"{mint.token}: {auth} has unreadable transactions; backfill cursor not advanced")
                        return False
                    before = page[-1]["signature"]
                    state["oldest_signature"] = before
                    state["oldest_slot"] = page[-1].get("slot")
                    log(f"[solana] {mint.token}: backfill of {auth} through slot {page[-1].get('slot')}")
                if len(page) < SIG_PAGE:
                    state["backfill_done"] = True
                    save()
                    stats.notes.append(f"{mint.token}: backfill of {auth} complete")
                    break
                save()
                time.sleep(self.call_sleep)
        return complete and bool(state.get("backfill_done"))

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

        def budget_left() -> bool:
            return max_calls is None or self.rpc.calls - calls_at_start < max_calls

        for mint in self.mints:
            cp = checkpoints.get(self.chain, mint.mint, {}) or {}
            auth = self.freeze_authority(mint.mint)
            if auth is None:
                stats.notes.append(f"{mint.token}: mint has no freeze authority; nothing to index")
                log(f"[solana] {mint.token}: no freeze authority on mint {mint.mint}")
                continue
            priors = cp.setdefault("authorities", {})
            previous = cp.get("freeze_authority")
            if previous and previous != auth:
                stats.notes.append(f"{mint.token}: freeze authority changed {previous} -> {auth}")
                # The old authority's cursors move under `authorities`. Its
                # history is walked again from the newest signature down to
                # them, which closes any gap before the rotation was seen.
                priors[previous] = {k: cp.pop(k) for k in self.CURSOR_KEYS if k in cp}
            cp.update({k: v for k, v in priors.pop(auth, {}).items() if k in self.CURSOR_KEYS})
            cp["freeze_authority"] = auth
            # every authority the mint is known to have had, oldest first
            history = [*mint.prior_freeze_authorities, *cp.get("authority_history", []), auth]
            cp["authority_history"] = list(dict.fromkeys(normalize.solana(a) for a in history))
            checkpoints.set(self.chain, mint.mint, cp)
            log(f"[solana] {mint.token}: freeze authority {auth}; history {', '.join(cp['authority_history'])}")

            def save() -> None:
                checkpoints.set(self.chain, mint.mint, cp)

            self._walk(mint, auth, cp, save, store, receipts, stats, log,
                       backfill=backfill, budget_left=budget_left)
            stats.cursor_to = str(cp.get("last_slot", ""))

            # Earlier authorities. One walked end to end after it lost the
            # authority can sign no further freeze of this mint, so it is closed
            # and later runs skip it.
            for prior in cp["authority_history"]:
                if prior == auth:
                    continue
                state = priors.setdefault(prior, {})
                if state.get("closed"):
                    continue
                if self._walk(mint, prior, state, save, store, receipts, stats, log,
                              backfill=backfill, budget_left=budget_left):
                    state["closed"] = True
                    save()
                    log(f"[solana] {mint.token}: earlier authority {prior} walked end to end; closed")
            slots = [s["oldest_slot"] for s in (cp, *priors.values()) if s.get("oldest_slot")]
            stats.cursor_from = str(min(slots)) if slots else ""
        stats.calls = self.rpc.calls - calls_at_start
        return stats
