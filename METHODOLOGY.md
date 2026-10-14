# Methodology

This document is written to be cited. It states what the ledger counts, what it does not, how a confidence rating is assigned, and the gaps the author knows about. Figures in the dataset should be read against it.

## 1. What a row is

A row in `freeze_events.csv` is one on-chain action by a stablecoin issuer against one address, recorded exactly once, identified by `{chain}:{tx_hash}:{log_index}`.

| `action` | Meaning | Where it comes from |
| --- | --- | --- |
| `freeze` | The issuer blocked the address from sending or receiving the token | Tether `AddedBlackList`; Circle `Blacklisted`; Solana `freezeAccount` |
| `unfreeze` | The block was lifted | Tether `RemovedBlackList`; Circle `UnBlacklisted`; Solana `thawAccount` |
| `destroy` | Tether zeroed the frozen balance and reduced supply (`amount` is the balance destroyed, in USDT) | Tether `DestroyedBlackFunds` (Ethereum, Tron) |

Circle's FiatToken has no destroy function; a frozen USDC balance stays on the address. Solana's Token Program has no destroy instruction either.

The ledger stores **events, not state**. "Currently frozen" is derived at export time from the last action per `(chain, token, address)` and is never stored as a flag, because an address can be frozen, released and frozen again.

## 2. Per-chain reads

**Ethereum and Base.** `eth_getLogs` over the issuer contract for the three Tether topics and the two Circle topics, in adaptive block chunks, from the contract's deployment block (found by binary search on `eth_getCode`, so no block number is copied from an explorer). Tether's contract is Solidity 0.4.x and emits its events with no indexed parameters, so the address is decoded from the data word; Circle's FiatToken indexes the account, so it is read from `topics[1]`. Block timestamps come from `eth_getBlockByNumber`. Only Circle's native USDC is read on Base; bridged `USDC.e` is a different contract with no Circle blacklister and is out of scope.

**Tron.** TronGrid's `/v1/contracts/{address}/events` endpoint, filtered by event name, ascending by block timestamp, paginated by fingerprint, with `only_confirmed=true`. Addresses arrive as hex or Base58 depending on the endpoint and are normalized to Base58Check. Tron carries the largest share of USDT freezes, so the first backfill is long; it is resumable and the checkpoint is per event name.

**Solana.** There is no blacklist event. A freeze is a Token Program `freezeAccount` instruction on a *token account*, signed by the mint's freeze authority; a thaw is `thawAccount`. On every run the adapter reads the freeze authority from the mint account (`getAccountInfo`), logs it, and records any change in `checkpoints.json` (`authority_history`). It then walks `getSignaturesForAddress(freezeAuthority)` and parses every transaction (`jsonParsed`, outer and inner instructions), keeping instructions whose `mint` is the one in scope. The frozen thing is a token account; its owning wallet is resolved from the transaction's token balances (or `getAccountInfo` as a fallback) and stored in `owner_address`. Reads use the `finalized` commitment. **Coverage caveat:** history is walked from the current freeze authority backwards; freezes signed by an earlier authority, if any, are reached only through `authority_history`, which starts the day the ledger first ran. A Tether mint with no freeze authority set yields no rows and says so in the run log.

## 3. Filters applied everywhere

- **Issuer-internal addresses.** Issuers blacklist their own token contract (so tokens cannot be sent to it) and occasionally other internal addresses. These rows are kept, flagged `issuer_internal=true`, and excluded from every headline count.
- **Removed logs.** A log with `removed=true` is never stored. On incremental runs the last 64 blocks (Ethereum, Base) or 5 minutes (Tron) before the checkpoint are re-read; a stored event the chain no longer returns is reported in the run log as a reorg candidate and handled by a dated entry in `CHANGELOG.md`, never a silent delete.
- **Confirmations.** EVM chains are read to `head − 12`; Tron with `only_confirmed`; Solana at `finalized`.

## 4. Receipts

Before a row is derived, the raw provider response it comes from is hashed (SHA-256) and written under `evidence/raw/{YYYY-MM-DD}/{hash16}.json`; the row carries the receipt's `evidence_id`. Identical responses share one receipt. The SDN XML is too large to keep in the repo, so its hash and size are indexed and the file itself is gitignored. Receipts are kept for responses that yield rows; routine reads (block numbers, block timestamps) are not receipted.

## 5. Attribution

The freeze is a fact; what is graded is the claim *"this freeze is explained by this record."*

**Automatic.** `sdn` downloads `sdn_advanced.xml` and extracts every `Digital Currency Address - <ASSET>` feature with the party's primary name, its program codes (the `SanctionsMeasure` entries whose type is "Program") and its earliest `EntryEvent` date. `attribute` joins these to frozen addresses by exact match within an address family (EVM, Tron, Solana). An SDN address listed under one asset code (e.g. `USDT`) matches freezes of either token on any EVM chain, because the address is the same; the asset code is recorded in `basis`. When the Federal Register API returns an OFAC notice naming the entity within 45 days of the listing date, a second row links the dated notice.

**Manual.** `data/attributions_manual.csv` holds records a parser cannot match: DOJ complaints, court orders, issuer statements, explorer labels. Each line names the record, the match basis and the evidence URL; it is graded by the same rules.

**Rules** (`freeze_ledger/attribution/grade.py`):

| Confidence | Rule |
| --- | --- |
| High | Exact address in a primary record (SDN, Federal Register, DOJ, court); freeze no earlier than 30 days before the record date |
| Moderate | Exact address in a primary record but the freeze predates it by more than 30 days (the record corroborates the actor, not the trigger); or a primary record states an amount and date matching a single destroy event but no address |
| Low | Secondary source only (explorer label, press, tracker), or date proximity alone |

Two Lows never make a Moderate. Moderate rises to High only when a second primary source agrees. Every row has a `basis` sentence stating why it is not one level higher, and `judged_at`. A re-judgment appends a new row and marks the previous one `superseded_by`; nothing is edited in place.

**Unattributed** is the absence of any non-superseded row for a frozen address. It is reported on the page as a first-class number and is expected to be the majority of Tron freezes. It means no public record was found after the standard search, not that none exists.

## 6. Verification

`verify.py` runs before any commit and exits non-zero on any mismatch:

1. **schema** — required columns; `event_id` canonical and unique; addresses in canonical form.
2. **receipts** — every row's receipt is indexed; every raw file present still hashes to its recorded value and contains the row's transaction hash.
3. **views** — `latest.json` equals the views recomputed from the CSVs; the CSV hashes it records still match.
4. **chain** — a seeded random sample of rows per chain is re-fetched from a *different* public endpoint (`eth_getTransactionReceipt`, TronGrid `transactions/{id}/events`, `getTransaction`) and compared field by field.
5. **sdn** — every address in 0xB10C's independent nightly extract of the SDN list is present in ours (tolerance 2%).

The suite was made to fail on purpose during development by editing a stored address and by altering a raw receipt (`tests/test_store_export_verify.py`).

## 7. Known gaps

- Polygon, Arbitrum, Avalanche and the other chains carrying Circle's FiatToken or Tether's contract are out of scope for v1.
- Solana coverage before the first observed freeze authority depends on `authority_history` (see §2).
- An SDN address and a frozen address can coincide for an exchange deposit address shared by many users; the High rule's timing window reduces but does not eliminate this, which is why `basis` states the window and the SDN asset code.
- Free public endpoints prune history and cap `eth_getLogs` ranges; the adaptive chunking and the second-endpoint re-derivation exist for this reason. On Ethereum and Base, any chunk that returns events is re-counted on an independent endpoint; a mismatch is re-fetched once, and if it persists the primary result is stored and the discrepancy is written to the run log for `verify.py` and the maintainer.
- The SDN parser was validated against a fixture in the advanced-XML shape; its first real run should be spot-checked (ten rows) against https://sanctionssearch.ofac.treas.gov/ and any discrepancy filed as an issue.

## Schema

**`freeze_events.csv`**

| Column | Type | Notes |
| --- | --- | --- |
| `event_id` | string | `{chain}:{tx_hash}:{log_index}`; primary key |
| `chain` | enum | ethereum, base, tron, solana |
| `issuer` | enum | tether, circle |
| `token` | enum | USDT, USDC |
| `action` | enum | freeze, unfreeze, destroy |
| `address` | string | Canonical per chain (EVM lowercase hex; Tron Base58Check; Solana Base58). On Solana, the token account |
| `owner_address` | string | Solana only: the wallet owning the token account |
| `amount` | decimal | Destroy events only; token units with 6 decimals |
| `block_number` | int | Slot on Solana |
| `block_time` | timestamp | ISO-8601 UTC |
| `tx_hash` | string | Signature on Solana |
| `log_index` | int | Instruction position on Solana (`outer*100 + inner+1`) |
| `issuer_internal` | bool | `true` when the address is the issuer's own contract or mint |
| `evidence_id` | string | Receipt in `evidence.csv` |
| `indexed_at` | timestamp | First written; never updated |

**`attributions.csv`**

| Column | Type | Notes |
| --- | --- | --- |
| `attribution_id` | string | Primary key |
| `address`, `chain` | string | Join to `freeze_events` |
| `source_class` | enum | ofac_sdn, federal_register, doj, court, issuer, explorer_label, press, tracker |
| `entity` | string | As the record states it |
| `program` | string | Sanctions program code(s), `;`-separated |
| `record_date` | date | Designation, filing or announcement date |
| `confidence` | enum | high, moderate, low |
| `basis` | string | Why this rating and not the next one up |
| `evidence_url` | string | The record |
| `judged_at` | date | When the rating was assigned |
| `superseded_by` | string | Set when a later judgment replaced this row |

**`evidence.csv`**

| Column | Type | Notes |
| --- | --- | --- |
| `evidence_id` | string | `ev_` + first 16 hex of the SHA-256 |
| `kind` | enum | rpc_log, trongrid_event, solana_tx, sdn_xml |
| `locator` | string | Endpoint + method + range, API URL, or download URL and date |
| `fetched_at` | timestamp | UTC |
| `sha256` | string | Of the raw bytes |
| `bytes` | int | Size |
