# Site

The page at jakepercy.com/freeze-ledger/ and on GitHub Pages. React + Vite + TypeScript, Tailwind v4, React Three Fiber for the field, GSAP ScrollTrigger for the chapters, Framer Motion for the DOM, D3 scales for the charts, cmdk for ⌘K.

```bash
cd site
npm ci
npm run dev        # reads ../data/ as static files
npm run build      # -> dist/, with ../data/ copied beside the page
FL_BASE=/ npm run build   # to host at a domain root
```

The page reads `site.json`, `latest.json`, `attributions.csv` and `verification_report.json` from the repo's `data/` folder; `python -m freeze_ledger export` writes them. Nothing on the page is typed by hand except sentence frames; every figure is a field of `latest.json`, which `verify.py` recomputes before any commit.

Two things run in the visitor's browser against public JSON-RPC endpoints, with no server in between: the live `isBlackListed` / `isBlacklisted` check on the issuer contracts, and the re-derivation of a row from its transaction receipt.

`?hero=timeline|entities|chains` picks the field's first arrangement; `?a=<address>` opens a lookup.
