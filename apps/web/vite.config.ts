import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The daemon the dev server proxies to. Start it with QF_ALLOWED_ORIGINS=http://localhost:5173. */
const daemon = process.env.QF_DAEMON_URL ?? "http://127.0.0.1:4747";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: daemon, ws: true, changeOrigin: true },
    },
  },
  build: {
    target: "es2023",
    sourcemap: true,
  },
});
