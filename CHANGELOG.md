# Changelog

Every correction to published data is recorded here with a date. Nightly
appends are not listed (they are the dated release tags); corrections are.

## Unreleased

- 2026-10-15 — First data: Ethereum (USDT freezes from block 18,900,000 / 2024-01-02; USDT destroys and releases, USDC freezes and releases from contract deployment) and Base (USDC, from deployment) imported from Etherscan `getLogs` pages saved verbatim and filed as receipts (`kind=etherscan_log`, 9 receipts, 5,376 rows). Attributions from the independent SDN extract only (no entity names or listing dates yet). `scripts/import_etherscan_pages.py` is the import path; checkpoints are set so `run` continues from the last imported block.

- 2026-10-13 — v0.1.0: indexer (Ethereum, Base, Tron, Solana), SDN extraction, grading rules, verification suite, nightly workflow, site page. No data published yet.
