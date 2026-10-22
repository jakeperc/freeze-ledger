import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cpSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

// The site is published on GitHub Pages at the root of freeze-ledger.jakepercy.com
// (the custom domain in the repo's Pages settings; jakeperc.github.io/freeze-ledger/
// redirects there). The repo's data/
// folder is served as static files next to the page, so the CSVs are the
// downloads and latest.json / site.json are what the scene reads. The page's
// own static files (share card, icons, manifest, 404) live in site/static.
const BASE = process.env.FL_BASE ?? "/";
const SITE_URL = process.env.FL_SITE_URL ?? "https://freeze-ledger.jakepercy.com/";
const DATA = resolve(__dirname, "../data");
const STATIC = resolve(__dirname, "static");

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
};

/** Serves site/static in dev and copies it into the build, beside data/. */
function staticFiles(): Plugin {
  return {
    name: "fl-static",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if (!path.startsWith(BASE)) return next();
        const file = join(STATIC, decodeURIComponent(path.slice(BASE.length)));
        if (!file.startsWith(STATIC) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader("Content-Type", TYPES[extname(file)] ?? "application/octet-stream");
        res.end(readFileSync(file));
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      cpSync(STATIC, options.dir, { recursive: true });
      const notFound = join(options.dir, "404.html");
      writeFileSync(notFound, readFileSync(notFound, "utf-8").replaceAll("__BASE__", BASE));
    },
  };
}

/** Absolute URLs for link previews, and the dataset's date for search engines. */
function headMeta(): Plugin {
  return {
    name: "fl-head",
    transformIndexHtml(html) {
      let modified = "";
      try {
        modified = JSON.parse(readFileSync(join(DATA, "latest.json"), "utf-8")).generated_at ?? "";
      } catch {
        /* no data yet: leave the date out */
      }
      const dataset = {
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "Freeze Ledger",
        description:
          "Every USDT and USDC issuer freeze, release and destroyed balance on Ethereum, Base, Tron and Solana, read from the chain nightly, with a receipt for each row and graded links to the public record.",
        url: SITE_URL,
        sameAs: "https://github.com/jakeperc/freeze-ledger",
        license: "https://creativecommons.org/licenses/by/4.0/",
        isAccessibleForFree: true,
        creator: { "@type": "Person", name: "Jake Percy", url: "https://jakepercy.com" },
        keywords: ["stablecoin", "USDT", "USDC", "Tether", "Circle", "blacklist", "freeze", "OFAC", "sanctions"],
        ...(modified ? { dateModified: modified } : {}),
        distribution: ["freeze_events.csv", "attributions.csv", "evidence.csv"].map((f) => ({
          "@type": "DataDownload",
          encodingFormat: "text/csv",
          contentUrl: SITE_URL + f,
        })),
      };
      return html
        .replaceAll("__SITE_URL__", SITE_URL)
        .replace("</head>", `    <script type="application/ld+json">${JSON.stringify(dataset)}</script>\n  </head>`);
    },
  };
}

export default defineConfig({
  base: BASE,
  plugins: [react(), tailwindcss(), staticFiles(), headMeta()],
  publicDir: DATA,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 900, // three.js (~820 KB, loaded after first paint) is the largest chunk; warn if anything outgrows it
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three", "@react-three/fiber"],
          motion: ["gsap", "framer-motion"],
        },
      },
    },
  },
});
