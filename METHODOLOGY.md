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

**Solana.** There is no blacklist event. A freeze is a Token Program `freezeAccount` instruction on a *token account*, signed by the mint's freeze authority; a thaw is `thawAccount`. On every run the adapter reads the freeze authority from the mint account (`getAccountInfo`), logs it, and records any change in `checkpoints.json` (`authority_history`). It then walks `getSignaturesForAddress(freezeAuthority)` and parses every transaction (`jsonParsed`, outer and inner instructions), keeping instructions whose `mint` is the one in scope. The frozen thing is a token account; its owning wallet is resolved from the transaction's token balances (or `getAccountInfo` as a fallback) and stored in `owner_address`. Reads use the `finalized` commitment. **Earlier authorities.** A mint's freeze authority can be changed by `setAuthority`, and the mint account names only the current one, so every authority it has had is listed in `authority_history`: the earlier ones are seeded from `registry.py` (each with the `setAuthority` transaction that ended it) and a rotation seen on a run is appended. Each authority's history is walked the same way. An earlier authority walked end to end after it lost the authority can sign no further freeze of the mint, so it is marked `closed` and skipped by later runs. Public endpoints prune history at different depths, so a `null` transaction or an empty page is retried on the next endpoint (the full-history one, `api.mainnet-beta.solana.com`, is tried first on every call), and a page with a transaction no endpoint returned leaves the cursors where they were, so the next run reads it again. A Tether mint with no freeze authority set yields no rows and says so in the run log.

## 3. Filters applied everywhere

- **Issuer-internal addresses.** Issuers blacklist their own token contract (so tokens cannot be sent to it) and occasionally other internal addresses. These rows are kept, flagged `issuer_internal=true`, and excluded from every headline count.
- **Removed logs.** A log with `removed=true` is never stored. On incremental runs the last 64 blocks (Ethereum, Base) or 5 minutes (Tron) before the checkpoint are re-read; a stored event the chain no longer returns is reported in the run log as a reorg candidate and handled by a dated entry in `CHANGELOG.md`, never a silent delete.
- **Confirmations.** EVM chains are read to `head − 12`; Tron with `only_confirmed`; Solana at `finalized`.

## 4. Receipts

Before a row is derived, the raw provider response it comes from is hashed (SHA-256) and written under `evidence/raw/{YYYY-MM-DD}/{hash16}.json`; the row carries the receipt's `evidence_id`. Identical responses share one receipt. The SDN XML is too large to keep in the repo, so its hash and size are indexed and the file itself is gitignored. Receipts are kept for responses that yield rows; routine reads (block numbers, block timestamps) are not receipted.

## 5. Attribution

The freeze is a fact; what is graded is the claim *"this freeze is explained by this record."*

**Automatic.** `sdn` downloads `sdn_advanced.xml` and extracts every `Digital Currency Address - <ASSET>` feature with the party's primary name, its program codes (the `SanctionsMeasure` entries whose type is "Program") and the party's earliest `EntryEvent` date (`listed_date` in `sdn_addresses.csv`). `attribute` joins these to frozen addresses by exact match within an address family (EVM, Tron, Solana). An SDN address listed under one asset code (e.g. `USDT`) matches freezes of either token on any EVM chain, because the address is the same; the asset code is recorded in `basis`. On Solana, OFAC lists a wallet and the issuer freezes a token account; a listed wallet matches every frozen token account it owns (`owner_address`), and the row is written against the token account.

**When the address was listed.** `listed_date` dates the *party*, not the address. Parties often gain addresses years after they are designated (a central bank designated in 2010 with Tron addresses added in 2025), and the XML gives no date per address. Grading against the party date let a freeze that came before the address was public pass as High. The record date graded against is therefore the address's own listing, read from the git history of 0xB10C's nightly SDN extract (`sdn` refreshes `data/sdn_address_history.csv`; `sdn --history-only` does just that). The extract is committed only on nights the list changes, from 2022-09-03:

- An address first seen after 2022-09-03 was listed within a day before that commit. Its window is one day wide.
- An address already in the first snapshot, or present when its asset code's file first appeared (USDT 2023-05, TRX and USDC 2023-12, SOL 2026-05), was listed on or before that day and no earlier than its party's designation. High needs the freeze to be no more than 30 days before the *latest* possible date; a freeze inside the window is Moderate, and `basis` says the record may postdate it.

The same history records removals. An address OFAC listed and later removed (the 90 removed on 2025-03-21, for example) is missing from today's XML, but it was a primary record while it stood. It is attributed with an empty `entity` and `program`, a `basis` that gives the removal date, and an `evidence_url` pointing at the extract commit that first listed it.

When the Federal Register API returns an OFAC notice naming the entity within 45 days of the party's listing date, a second row links the dated notice, but only if the notice falls within 45 days of the address's own listing window. A 2010 notice cannot have named an address added in 2025.

**Manual.** `data/attributions_manual.csv` holds records a parser cannot match: DOJ complaints, court orders, issuer statements, explorer labels. Each line names the record, the match basis and the evidence URL; it is graded by the same rules.

**Rules** (`freeze_ledger/attribution/grade.py`):

| Confidence | Rule |
| --- | --- |
| High | Exact address in a primary record (SDN, Federal Register, DOJ, court); freeze no earlier than 30 days before the record date |
| Moderate | Exact address in a primary record but the freeze predates it by more than 30 days (the record corroborates the actor, not the trigger); or a primary record states an amount and date matching a single destroy event but no address |
| Low | Secondary source only (explorer label, press, tracker), or date proximity alone |

Two Lows never make a Moderate. Moderate rises to High only when a second primary source agrees. Every row has a `basis` sentence stating why it is not one level higher, and `judged_at`. A re-judgment (a changed rating, record date or basis) appends a new row and marks the previous one `superseded_by`; nothing is edited in place. An automatic row that no rule produces any more (such as a notice link that fails the window above) is marked `superseded_by = withdrawn:<date>`.

**Unattributed** is the absence of any non-superseded row for a frozen address. It is reported on the page as a first-class number and is expected to be the majority of Tron freezes. It means no public record was found after the standard search, not that none exists.

## 6. Verification

`verify.py` runs before any commit and exits non-zero on any mismatch:

1. **schema** — required columns; `event_id` canonical and unique; addresses in canonical form.
2. **receipts** — every row's receipt is indexed; every raw file present still hashes to its recorded value and contains the row's transaction hash.
3. **views** — `latest.json` equals the views recomputed from the CSVs; the CSV hashes it records still match.
4. **chain** — a seeded random sample of rows per chain is re-fetched from a *different* public endpoint (`eth_getTransactionReceipt`, TronGrid `transactions/{id}/events`, `getTransaction`) and compared field by field. On Solana, public endpoints prune history at different depths; when the second endpoint answers `null` for a sampled transaction, the next endpoint is tried and the report names which endpoint served each sample.
5. **sdn** — every address in 0xB10C's independent nightly extract of the SDN list is present in ours (tolerance 2%).

The suite was made to fail on purpose during development by editing a stored address and by altering a raw receipt (`tests/test_store_export_verify.py`).

## 7. Known gaps

- Polygon, Arbitrum, Avalanche and the other chains carrying Circle's FiatToken or Tether's contract are out of scope for v1.
- Solana coverage depends on `authority_history` being complete (see §2). For USDC it is: the mint was initialized with freeze authority `5TYZChz7APFopR5QirD5of4rQj1p9AXxeSAg6JndBdGj` (tx `3J3ijbvs…`, slot 41,323,234, 2020-10-13), which handed it to the 2-of-3 token multisig `3sNBr7kMccME5D55xNgsmYpZnzPgP2g12CixAajXypn6` (tx `5i76veDq…`, slot 41,592,684, 2020-10-14), which handed it to the current 2-of-4 multisig `7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar` on 2024-08-23 (tx `5afAPFJq…`, slot 285,371,061). The first key signed no freeze; the first USDC freeze on Solana is 2022-11-11. A future authority change is caught by the mint read on each run; one made and reversed between two runs would be missed. Solana USDT is not yet indexed: its authority's history is mostly unrelated transactions that reference it, so every one must be fetched to find the freezes.
- An SDN address and a frozen address can coincide for an exchange deposit address shared by many users; the High rule's timing window reduces but does not eliminate this, which is why `basis` states the window and the SDN asset code.
- Free public endpoints prune history and cap `eth_getLogs` ranges; the adaptive chunking and the second-endpoint re-derivation exist for this reason. On Ethereum and Base, any chunk that returns events is re-counted on an independent endpoint; a mismatch is re-fetched once, and if it persists the primary result is stored and the discrepancy is written to the run log for `verify.py` and the maintainer.
- The SDN parser was validated against a fixture in the advanced-XML shape; its first real run should be spot-checked (ten rows) against https://sanctionssearch.ofac.treas.gov/ and any discrepancy filed as an issue.
- Address listing dates before 2022-09-03 are bounded, not known (see §5). Entity and program for removed listings are not in the extract history; the Treasury action that removed them is the place to read them.
- The listing-to-freeze views in `latest.json` (`sdn_listing_lag_days`) count only addresses whose listing date is known to the day, on lanes already live when they were listed. The extract commits when its nightly run sees a change, which can trail OFAC by a day or two, so "within 2 days" counts lags from -2 to 2 and "before listing" needs the freeze a week or more before the first sighting.

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
| `superseded_by` | string | The `attribution_id` of the later judgment that replaced this row, or `withdrawn:<date>` when no rule produces it any more |

**`sdn_address_history.csv`**

| Column | Type | Notes |
| --- | --- | --- |
| `chain_hint`, `address_norm` | string | Address family (evm, tron, solana) and normalized address |
| `assets` | string | SDN asset codes it was listed under, `;`-separated |
| `first_seen` | date | First nightly extract commit containing it: the latest it can have been listed |
| `not_before` | date | The day before `first_seen` when the extract was already nightly; empty when it was in the first snapshot (2022-09-03) |
| `last_seen` | date | Last commit containing it |
| `removed_at` | date | Commit that dropped it, if it is no longer listed |
| `first_commit`, `removed_commit` | string | Commit hashes in 0xB10C/ofac-sanctioned-digital-currency-addresses, branch `lists` |

**`evidence.csv`**

| Column | Type | Notes |
| --- | --- | --- |
| `evidence_id` | string | `ev_` + first 16 hex of the SHA-256 |
| `kind` | enum | rpc_log, trongrid_event, solana_tx, sdn_xml |
| `locator` | string | Endpoint + method + range, API URL, or download URL and date |
| `fetched_at` | timestamp | UTC |
| `sha256` | string | Of the raw bytes |
| `bytes` | int | Size |
