import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the UI runs on 5173 and proxies the API to the XTree server on 4317
// (start it with `bun run dev:server`). Without a server the UI falls back to mock data.
const backend = process.env.XTREE_BACKEND ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
});
