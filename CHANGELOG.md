# Changelog

Every correction to published data is recorded here with a date. Nightly
appends are not listed (they are the dated release tags); corrections are.

## Unreleased

- 2026-10-15 — Ethereum USDT freezes before block 18,900,000 backfilled from public RPC (`backfill --chain ethereum --to-block 18900000`, blocks 4,634,748 → 18,900,000, primary `rpc.mevblocker.io`): 1,250 new rows filed as `rpc_log` receipts; USDT freeze coverage now starts 2017-11-28. The per-chunk cross-check against `eth.drpc.org` was unavailable (its free plan rejected the 10,000-block ranges); the rows pass `verify.py` re-derivation against a second endpoint. SDN extract replaced by the full `sdn_advanced.xml` parse (1,066 rows, with entity, program and listing date); the 256 attributions judged from the independent extract are superseded by graded rows, which moves 3 addresses from High to Moderate (frozen before their listing). Default Ethereum endpoints now include two that still serve pre-merge history. Fixes in `verify.py`: the SDN cross-check lowercased base58 addresses on one side only, and `views.latest` compared tuples to the JSON lists in `latest.json`. `evidence/raw/` is marked `-text` so a Windows checkout keeps receipt bytes (and hashes) intact.

- 2026-10-15 — First data: Ethereum (USDT freezes from block 18,900,000 / 2024-01-02; USDT destroys and releases, USDC freezes and releases from contract deployment) and Base (USDC, from deployment) imported from Etherscan `getLogs` pages saved verbatim and filed as receipts (`kind=etherscan_log`, 9 receipts, 5,376 rows). Attributions from the independent SDN extract only (no entity names or listing dates yet). `scripts/import_etherscan_pages.py` is the import path; checkpoints are set so `run` continues from the last imported block.

- 2026-10-13 — v0.1.0: indexer (Ethereum, Base, Tron, Solana), SDN extraction, grading rules, verification suite, nightly workflow, site page. No data published yet.
