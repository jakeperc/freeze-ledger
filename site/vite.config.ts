import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// The site is a sub-app at jakepercy.com/freeze-ledger/ and on GitHub Pages.
// The repo's data/ folder is served as static files next to the page, so the
// CSVs are the downloads and latest.json / site.json are what the scene reads.
export default defineConfig({
  base: process.env.FL_BASE ?? "/freeze-ledger/",
  plugins: [react(), tailwindcss()],
  publicDir: resolve(__dirname, "../data"),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 600, // three.js is lazy; anything this big on the critical path should warn
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
