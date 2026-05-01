import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const BACKEND = process.env.MOO_BACKEND || "http://127.0.0.1:7777";

export default defineConfig({
  plugins: [solid()],
  server: {
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
