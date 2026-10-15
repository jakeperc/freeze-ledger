#!/usr/bin/env python3
"""Import saved Etherscan `getLogs` pages into the ledger.

A bootstrap path for when public RPCs are unreachable: each page file is the
verbatim `result` array of an Etherscan V2 `module=logs&action=getLogs`
response (same log shape as eth_getLogs, plus `timeStamp`). The page bytes
are filed as the receipt (kind `etherscan_log`), and every log is decoded
with the same EventSpec/decoder the RPC adapter uses, so the rows are
indistinguishable from an RPC run except for the receipt kind.

Usage: python scripts/import_etherscan_pages.py bootstrap/*.json
File names must start with the chain: eth_* -> ethereum, base_* -> base.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from freeze_ledger import paths, registry  # noqa: E402
from freeze_ledger.adapters.base import Adapter, iso_from_unix  # noqa: E402
from freeze_ledger.adapters.evm import decode_log, format_amount  # noqa: E402
from freeze_ledger.checkpoint import Checkpoints  # noqa: E402
from freeze_ledger.receipts import Receipts  # noqa: E402
from freeze_ledger.store import event_store  # noqa: E402

CHAIN_PREFIX = {"eth_": "ethereum", "base_": "base"}


def hexint(v: str) -> int:
    v = (v or "0x0").lower()
    return int(v[2:] or "0", 16) if v.startswith("0x") else int(v)


def main(files: list[str]) -> int:
    paths.ensure_dirs()
    store, receipts, cps = event_store(), Receipts(), Checkpoints()
    by_topic = {}
    for c in registry.EVM_CONTRACTS:
        for s in c.events:
            by_topic[(c.chain, s.topic0)] = (c, s)
    total_new = total_seen = 0
    maxblock: dict[str, int] = {}
    for f in sorted(files):
        p = Path(f)
        chain = next((v for k, v in CHAIN_PREFIX.items() if p.name.startswith(k)), None)
        if not chain or not p.name.endswith(".json") or p.name.endswith(".raw.json"):
            continue
        raw = p.read_bytes()
        logs = json.loads(raw)
        if not isinstance(logs, list):
            print(f"skip {p.name}: not a result array")
            continue
        first = next((c for c in registry.EVM_CONTRACTS if c.chain == chain and c.address.lower() == logs[0]["address"].lower()), None) if logs else None
        locator = (
            f"etherscan v2 getLogs chainid={registry.EVM_CONTRACTS and {'ethereum': 1, 'base': 8453}[chain]} "
            f"address={first.address if first else '?'} topic0={logs[0]['topics'][0] if logs else '?'} page={p.stem.rsplit('page', 1)[-1]}"
        )
        eid = receipts.record("etherscan_log", locator, raw)
        batch = []
        for lg in logs:
            topic0 = lg["topics"][0].lower()
            hit = by_topic.get((chain, topic0))
            if not hit:
                continue
            contract, spec = hit
            if lg["address"].lower() != contract.address.lower():
                continue
            decoded = decode_log(lg, spec)
            address = decoded[spec.params[0][0]]
            amount = format_amount(decoded[spec.params[1][0]]) if spec.action == "destroy" else ""
            block = hexint(lg["blockNumber"])
            maxblock[chain] = max(maxblock.get(chain, 0), block)
            ev = Adapter.make_event(
                chain=chain, issuer=contract.issuer, token=contract.token, action=spec.action,
                address=address, owner_address="", amount=amount, block_number=block,
                block_time=iso_from_unix(hexint(lg["timeStamp"])), tx_hash=lg["transactionHash"].lower(),
                log_index=hexint(lg.get("logIndex") or "0x0"),
                issuer_internal=(address == contract.address.lower()), evidence_id=eid,
            )
            batch.append(ev.as_row())
        new = store.append(batch)
        total_seen += len(batch)
        total_new += new
        print(f"{p.name:40s} {len(batch):5d} decoded  {new:5d} new  receipt {eid}")
    for chain, b in maxblock.items():
        # Leave the checkpoint where the bootstrap reached so `run` continues from here.
        prev = cps.get(chain, "last_block")
        if prev is None or b > int(prev):
            cps.set(chain, "last_block", b)
            cps.set(chain, "bootstrap", {"source": "etherscan_getlogs_pages", "through_block": b})
    print(f"total: {total_seen} decoded, {total_new} new rows; store now {len(store)} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
