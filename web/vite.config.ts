import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const BACKEND = process.env.MOO_BACKEND || "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [solid()],
  build: {
    // Moo embeds Vite output as one HTML string; keep Blit's small WASM payload inline.
    assetsInlineLimit: 256 * 1024,
    // The embedded UI is intentionally one JS chunk; warn only if it grows
    // well past the current production bundle size.
    chunkSizeWarningLimit: 7000,
    rolldownOptions: {
      output: {
        // The Rust build embeds Vite's HTML by inlining only the entry CSS and
        // module script into default_ui.html. Mermaid loads diagram renderers
        // through dynamic imports, so keep those chunks in the entry module
        // instead of emitting /assets/*.js files the embedded UI cannot fetch.
        codeSplitting: false,
      },
    },
  },
  server: {
    allowedHosts: true,
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND,
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
