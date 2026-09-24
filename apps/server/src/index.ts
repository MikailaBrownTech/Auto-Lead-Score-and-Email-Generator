import { serve } from "@hono/node-server";
import { bootstrapOrExit } from "./bootstrap";
import { fromRoot } from "./config/paths";
import { createApp } from "./server/app";
import { createLocalToken } from "./server/local-guard";

const HOSTNAME = "127.0.0.1"; // localhost only; deliberately not configurable

const ctx = bootstrapOrExit();
const token = createLocalToken(fromRoot("data/.local-token"));
const app = createApp({
  guard: { port: ctx.env.PORT, token, allowedOrigins: ctx.env.WEB_ORIGINS },
  gate: ctx.gate,
  db: ctx.db,
});

serve({ fetch: app.fetch, hostname: HOSTNAME, port: ctx.env.PORT }, (info) => {
  console.log(`[clearpath] API listening on http://${HOSTNAME}:${info.port} (localhost only)`);
  console.log(
    `[clearpath] Spend this month: $${ctx.gate.spentThisMonthUsd().toFixed(4)} of $${ctx.gate.capUsd.toFixed(2)} cap`,
  );
});
