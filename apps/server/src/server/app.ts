import { Hono } from "hono";
import type { CacheHealth, SpendSummary } from "@clearpath/shared";
import type { Db } from "../db/client";
import { cacheHealth } from "../llm/cache-health";
import type { SpendGate } from "../llm/spend-gate";
import { localGuard, type LocalGuardOptions } from "./local-guard";

export interface AppDeps {
  guard: LocalGuardOptions;
  gate: SpendGate;
  db: Db;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();

  app.use("/api/*", localGuard(deps.guard));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/spend", (c) => {
    const body: SpendSummary = {
      month: deps.gate.currentMonth(),
      spentUsd: deps.gate.spentThisMonthUsd(),
      reservedUsd: deps.gate.reservedUsd(),
      capUsd: deps.gate.capUsd,
    };
    return c.json(body);
  });

  app.get("/api/cache-health", (c) => {
    const body: CacheHealth = cacheHealth(deps.db);
    return c.json(body);
  });

  return app;
}
