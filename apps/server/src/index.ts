import { serve } from "@hono/node-server";
import { verifyAccessToken } from "./auth/supabase";
import { bootstrapOrExit } from "./bootstrap";
import { fromRoot } from "./config/paths";
import { createApp } from "./server/app";
import { JobRunner } from "./server/jobs";
import { newLocalToken, writeLocalToken } from "./server/local-guard";
import type { Services } from "./server/services";

const HOSTNAME = "127.0.0.1"; // localhost only; deliberately not configurable

const ctx = bootstrapOrExit();
const token = newLocalToken();
const services: Services = { db: ctx.db, llm: ctx.llm, gate: ctx.gate, env: ctx.env };
const app = createApp({
  guard: { port: ctx.env.PORT, token, allowedOrigins: ctx.env.WEB_ORIGINS },
  verifyToken: (accessToken) => verifyAccessToken(ctx.env, accessToken),
  gate: ctx.gate,
  db: ctx.db,
  services,
  jobs: new JobRunner(services),
});

const server = serve({ fetch: app.fetch, hostname: HOSTNAME, port: ctx.env.PORT }, (info) => {
  // Only now that the port is ours: a second copy that fails to bind must not replace the running token.
  writeLocalToken(fromRoot("data/.local-token"), token);
  console.log(`[clearpath] API listening on http://${HOSTNAME}:${info.port} (localhost only)`);
  console.log(
    `[clearpath] Spend this month: $${ctx.gate.spentThisMonthUsd().toFixed(4)} of $${ctx.gate.capUsd.toFixed(2)} cap`,
  );
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[clearpath] Port ${ctx.env.PORT} is already in use. The app is probably already running (check your other terminals), or set PORT in .env.`);
  } else {
    console.error(`[clearpath] The API could not start: ${err.message}`);
  }
  process.exit(1);
});
