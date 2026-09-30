import { describe, expect, it } from "vitest";
import { authGuard } from "../src/auth/guard";
import { openDb } from "../src/db/client";
import { SpendGate } from "../src/llm/spend-gate";
import { createApp } from "../src/server/app";
import { JobRunner } from "../src/server/jobs";
import { TOKEN_HEADER } from "../src/server/local-guard";
import type { Services } from "../src/server/services";

const PORT = 8787;
const LOCAL_TOKEN = "a".repeat(64);
const GOOD_ACCESS_TOKEN = "good-session-token";
const USER = { id: "user-1", email: "founder@example.com" };

const db = openDb(":memory:");
const gate = new SpendGate(db, 5);
const services = { db, gate } as unknown as Services;
const app = createApp({
  guard: { port: PORT, token: LOCAL_TOKEN, allowedOrigins: [] },
  verifyToken: async (t) => (t === GOOD_ACCESS_TOKEN ? USER : null),
  gate,
  db,
  services,
  jobs: new JobRunner(services),
});

function call(headers: Record<string, string> = {}) {
  return app.request(`http://127.0.0.1:${PORT}/api/health`, {
    headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: LOCAL_TOKEN, ...headers },
  });
}

describe("authGuard: every /api/* request needs a valid Supabase session", () => {
  it("401s with no Authorization header", async () => {
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  it("401s on a malformed Authorization header (not \"Bearer <token>\")", async () => {
    expect((await call({ authorization: GOOD_ACCESS_TOKEN })).status).toBe(401);
    expect((await call({ authorization: "Basic dXNlcjpwYXNz" })).status).toBe(401);
  });

  it("401s when the token doesn't verify (expired, revoked, or never valid)", async () => {
    const res = await call({ authorization: "Bearer wrong-or-expired-token" });
    expect(res.status).toBe(401);
  });

  it("passes through, re-validating against Supabase, when the token verifies", async () => {
    const res = await call({ authorization: `Bearer ${GOOD_ACCESS_TOKEN}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("authGuard unit: the middleware in isolation", () => {
  it("sets c.get(\"user\") from the verified token, for route handlers that need who's asking", async () => {
    const { Hono } = await import("hono");
    const mini = new Hono();
    mini.use("*", authGuard(async (t) => (t === GOOD_ACCESS_TOKEN ? USER : null)));
    mini.get("/whoami", (c) => c.json(c.get("user")));
    const res = await mini.request("/whoami", { headers: { authorization: `Bearer ${GOOD_ACCESS_TOKEN}` } });
    expect(await res.json()).toEqual(USER);
  });

  it("never calls verify for an empty token", async () => {
    const { Hono } = await import("hono");
    const mini = new Hono();
    let calls = 0;
    mini.use("*", authGuard(async () => { calls++; return null; }));
    mini.get("/x", (c) => c.json({ ok: true }));
    await mini.request("/x", { headers: { authorization: "Bearer " } });
    expect(calls).toBe(0);
  });
});
