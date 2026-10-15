# Freeze Ledger

An open, reproducible dataset of every address Tether and Circle have frozen or unfrozen on **Ethereum, Base, Tron and Solana**, read directly from the chain, with each freeze joined to the public record that explains it (OFAC SDN entry, Federal Register notice, DOJ filing, issuer statement) and graded on an ICD-203 confidence scale — or marked *unattributed* when no public record was found.

It is a dataset first, with a page on top. Every number is derived from a chain response whose raw bytes are hashed and kept, and the published figures are re-derived by a public verification suite before anything is committed.

> **Status: v0.1, first data.** Ethereum and Base are indexed (see *Status* below for exact coverage); Tron and Solana are not yet run. Every published figure passes `verify.py`.

## What you get

| File | What it is |
| --- | --- |
| `data/freeze_events.csv` | One row per on-chain action: `freeze`, `unfreeze`, or `destroy` (Tether zeroing a frozen balance). Append-only, never back-revised. |
| `data/attributions.csv` | Zero or more rows per frozen address linking it to a public record, with `confidence` (high / moderate / low), a `basis` sentence saying why it is not one level higher, the `evidence_url`, and the date the judgment was made. |
| `data/evidence.csv` + `evidence/raw/` | The receipts: SHA-256 and location of every raw response a row was derived from. |
| `data/latest.json` | Derived views the page reads: counts by chain and action, addresses frozen now, monthly series, attribution coverage, destroyed amounts, the registry of contracts, and file hashes. |
| `data/sdn_addresses.csv` | The OFAC SDN list's digital-currency addresses with entity, program(s) and listing date, extracted from `sdn_advanced.xml`. |
| `METHODOLOGY.md` | What counts as a freeze on each chain, what does not, how confidence is assigned, and the known gaps. |

Schema for all three tables is in [METHODOLOGY.md](METHODOLOGY.md#schema).

## Reproduce it

Standard library only. No API keys are required for Ethereum, Base or Solana; a free TronGrid key makes Tron faster.

```bash
git clone https://github.com/jakeperc/freeze-ledger
cd freeze-ledger
python -m pytest -q                       # the suite runs against fixtures, no network

export FL_TRON_API_KEY=...                # optional, https://www.trongrid.io/
python -m freeze_ledger backfill --chain ethereum      # years of history; resumable, Ctrl-C and re-run
python -m freeze_ledger backfill --chain base
python -m freeze_ledger backfill --chain tron          # the long one
python -m freeze_ledger backfill --chain solana
python -m freeze_ledger sdn               # download + extract the SDN digital-currency addresses
python -m freeze_ledger attribute         # join and grade
python -m freeze_ledger export            # write data/latest.json
python verify.py                          # re-derive a sample from a second endpoint; exits 1 on any mismatch
```

The committed data was bootstrapped from Etherscan `getLogs` pages (see CHANGELOG), so Ethereum USDT freezes before block 18,900,000 are not in yet. To fill that gap from a public RPC, walk from the deployment block up to the bootstrap checkpoint (resumable; re-walking indexed ranges adds nothing):

```bash
python -m freeze_ledger backfill --chain ethereum --to-block 18900000
```

Day to day, one command indexes forward from the committed checkpoints:

```bash
python -m freeze_ledger run
```

That is what `.github/workflows/nightly.yml` runs every night. It commits `data/` and tags a dated release only if `verify.py` passes; otherwise it opens an issue with the log and commits nothing.

Override endpoints with `FL_ETH_RPC`, `FL_BASE_RPC`, `FL_SOL_RPC` (comma-separated lists; the verification suite deliberately uses a *different* endpoint from the one that indexed).

## How it works

```
Ethereum RPC   Base RPC   TronGrid   Solana RPC
      \           |          |          /
       v          v          v         v
   adapters (one per chain, same interface)  ──>  evidence/raw/  (sha256 of every response)
                     |
                     v
          data/freeze_events.csv  (append-only, event_id = chain:tx:index)
                     |
          + SDN extract + manual records  ──>  grade.py  ──>  data/attributions.csv
                     |
                     v
              verify.py  (schema · receipts · recomputed views · chain re-derivation · SDN cross-check)
                     |
                     v  only on PASS
         commit data/ · tag vYYYY.MM.DD · site/index.html reads data/latest.json
```

- **Idempotent.** `event_id` is `{chain}:{tx_hash}:{log_index}`. Re-running over an indexed range writes nothing; running the full history from block zero yields the same `freeze_events.csv`.
- **No state outside git.** `data/checkpoints.json` holds the last block or signature per chain. The deployment block of each EVM contract is found by binary search on `eth_getCode`, not copied from an explorer.
- **Reorg margin.** Incremental runs re-read the last 64 blocks (Ethereum, Base) and 5 minutes (Tron) before the checkpoint; Solana reads at `finalized`. A stored event the chain no longer returns is reported in the run log, never silently dropped.
- **Receipts before rows.** The raw response is hashed and filed before any row is derived from it; the row carries the receipt id and the suite checks the file still hashes to it and contains the row's transaction hash.
- **Public endpoints by default**, so a stranger can reproduce the run.

### What counts as a freeze

| Chain | Issuer | Read |
| --- | --- | --- |
| Ethereum | Tether (USDT) | `AddedBlackList`, `RemovedBlackList`, `DestroyedBlackFunds` on `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| Ethereum | Circle (USDC) | `Blacklisted`, `UnBlacklisted` on `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | Circle (USDC) | same FiatToken events on `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (native USDC only) |
| Tron | Tether (USDT) | same Tether events on `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` via TronGrid |
| Solana | Circle (USDC), Tether (USDT) | Token Program `freezeAccount` / `thawAccount` instructions on the mint, signed by the mint's freeze authority (read from the mint on every run) |

`python -m freeze_ledger registry` prints every address, event signature, derived topic hash and the issuer page it was copied from.

### Confidence

| Level | Rule |
| --- | --- |
| **High** | The record names the exact address and is primary (SDN, Federal Register, DOJ, court), and the freeze is not earlier than 30 days before the record date. |
| **Moderate** | Exact address in a primary record but the freeze predates it (the record corroborates the actor, not the trigger); or a primary record cites an amount and date matching a single destroy event but no address. |
| **Low** | Secondary source only (explorer label, press, tracker), or date proximity alone. |
| *unattributed* | No public record found after the standard search. Reported as a first-class number. |

Two Lows never make a Moderate; Moderate becomes High only when a second primary source agrees. Every row's `basis` says why it is not one level higher. A changed judgment appends a row and marks the old one `superseded_by`.

## Adding a record by hand

Most non-SDN attributions (a DOJ forfeiture complaint, a court order, an issuer statement) cannot be matched by a parser. Add a line to `data/attributions_manual.csv`:

```
address,chain,source_class,entity,program,record_date,evidence_url,match_basis,amount_matches,notes
```

`source_class` ∈ `doj | court | federal_register | issuer | explorer_label | press | tracker`; `match_basis` ∈ `address | amount_date | date | secondary`. Run `attribute` and the row is graded by the same rules as everything else.

## Prior art and what is different

[BlockSec](https://blocksec.com/blog/usdt-blacklist-explained-2026) runs a live USDT freeze tracker; an [Apify actor](https://apify.com/amlconsensus/stablecoin-freeze-tracker) sells a scraped list; [Range](https://docs.range.org/risk-api/risk/get-sanctions-blacklist-check) sells a blacklist-check API. None publishes a versioned, downloadable dataset; none covers Solana freezes; none attaches a graded public-record attribution to each address. Those three gaps are what this repo fills. The OFAC extraction cross-checks itself against [0xB10C's nightly SDN address lists](https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses).

## Status

As of 2026-10-15 (first bootstrap, Ethereum + Base via Etherscan `getLogs` pages filed as receipts; Tron and Solana not yet run):

- Events indexed: **5,333** public (43 issuer-internal rows kept and flagged)
- Addresses frozen now: **3,591** (Ethereum USDT 2,435, Ethereum USDC 653, Base USDC 503)
- USDT destroyed after a freeze (Ethereum, all-time): **$818,478,019**
- Coverage: Ethereum USDC freezes 2020-06-16 → 2026-10-12 (complete); Ethereum USDT destroys and releases 2017-11-28 → 2026-10-09 (complete); **Ethereum USDT freezes 2024-01-02 → 2026-10-14 only** (earlier USDT freezes arrive with the RPC backfill); Base USDC 2023-08-18 → 2026-10-08 (complete)
- Attribution: **248** frozen addresses with a High attribution (exact match in the OFAC SDN digital-currency list via the independent nightly extract; entity names and listing dates pending the full `sdn_advanced.xml` run), **3,616** (93.6%) with no public record found yet

## License and citation

Code: MIT. Data (`data/`, `evidence/`): CC BY 4.0. Cite as *Percy, J. Freeze Ledger, release vYYYY.MM.DD, https://github.com/jakeperc/freeze-ledger*.

Attributions are the author's assessment of public records, not the issuer's stated reason for any freeze. "No public record found" means exactly that.
