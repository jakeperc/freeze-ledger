# Site

The page at jakepercy.com/freeze-ledger/ and on GitHub Pages. React + Vite + TypeScript, Tailwind v4, React Three Fiber for the field, GSAP ScrollTrigger for the chapters, Framer Motion for the DOM, D3 scales for the charts, cmdk for ⌘K.

```bash
cd site
npm ci
npm run dev        # reads ../data/ as static files
npm run build      # -> dist/, with ../data/ copied beside the page
FL_BASE=/ npm run build   # to host at a domain root
```

The page reads `latest.json`, `site.json`, `site_ids.json`, `attributions.csv` and `verification_report.json` from the repo's `data/` folder; `python -m freeze_ledger export` writes them. They load smallest first: the chapters render from `latest.json` (about 25 KB), the field from `site.json` (the columns it draws), and the lookup, registry and receipts once `site_ids.json` (every address and transaction hash) is in. Nothing on the page is typed by hand except sentence frames; every figure is a field of `latest.json`, which `verify.py` recomputes before any commit.

Two things run in the visitor's browser against public endpoints, with no server in between: the live check (`isBlackListed` / `isBlacklisted` on Ethereum and Base, Tether's `isBlackListed` on Tron through TronGrid, and token-account `state` on Solana), and the re-derivation of a row from its transaction (Ethereum, Base and Tron).

`?hero=timeline|entities` picks the field's first arrangement; `?a=<address>` opens a lookup (on Solana, the wallet or the token account).
