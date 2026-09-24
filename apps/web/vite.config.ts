import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tokenFile = path.join(repoRoot, "data/.local-token");
const apiPort = Number(process.env.PORT ?? 8787);

/** Read on every request: the API server writes a fresh token each time it starts. */
function readToken(): string {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("x-clearpath-token", readToken());
          });
        },
      },
    },
  },
});
