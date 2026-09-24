import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client";
import { SpendGate } from "../src/llm/spend-gate";
import { createApp } from "../src/server/app";
import { JobRunner } from "../src/server/jobs";
import type { Services } from "../src/server/services";
import { TOKEN_HEADER } from "../src/server/local-guard";

const PORT = 8787;
const TOKEN = "a".repeat(64);

const db = openDb(":memory:");
const gate = new SpendGate(db, 5);
// The guard runs before any route, so the services are never used here.
const services = { db, gate } as unknown as Services;
const app = createApp({
  guard: { port: PORT, token: TOKEN, allowedOrigins: ["http://localhost:5173"] },
  gate,
  db,
  services,
  jobs: new JobRunner(services),
});

function get(path: string, headers: Record<string, string>) {
  return app.request(`http://127.0.0.1:${PORT}${path}`, { headers });
}

const good = { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN };

describe("local guard", () => {
  it("allows a local request with the right token", async () => {
    const res = await get("/api/health", good);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts localhost as the Host too", async () => {
    expect((await get("/api/health", { ...good, host: `localhost:${PORT}` })).status).toBe(200);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    expect((await get("/api/health", { ...good, host: `evil.example:${PORT}` })).status).toBe(403);
    expect((await get("/api/health", { ...good, host: `127.0.0.1:9999` })).status).toBe(403);
  });

  it("rejects a foreign Origin", async () => {
    expect((await get("/api/health", { ...good, origin: "https://evil.example" })).status).toBe(403);
  });

  it("allows the configured dev origin", async () => {
    expect((await get("/api/health", { ...good, origin: "http://localhost:5173" })).status).toBe(200);
  });

  it("rejects a missing or wrong token", async () => {
    expect((await get("/api/health", { host: good.host })).status).toBe(401);
    expect((await get("/api/health", { ...good, [TOKEN_HEADER]: "b".repeat(64) })).status).toBe(401);
    expect((await get("/api/health", { ...good, [TOKEN_HEADER]: "short" })).status).toBe(401);
  });

  it("never sends CORS headers", async () => {
    const res = await get("/api/health", { ...good, origin: "http://localhost:5173" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("serves the spend summary", async () => {
    const res = await get("/api/spend", good);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ spentUsd: 0, reservedUsd: 0, capUsd: 5 });
    expect(body.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
