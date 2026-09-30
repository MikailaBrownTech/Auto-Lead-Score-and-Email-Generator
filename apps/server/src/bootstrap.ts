import { createServiceRoleClient } from "./auth/supabase";
import { loadEnv, type Env } from "./config/env";
import { fromRoot } from "./config/paths";
import { assertPricesFor, loadPriceTable, type PriceTable } from "./config/prices";
import { openDb, type Db } from "./db/client";
import { realEventsDb, realSequencesDb, type EventsDb, type SequencesDb } from "./db/supa-sequences";
import { realLeadsDb, type LeadsDb } from "./db/supa-leads";
import { realRunsDb, type RunsDb } from "./db/supa-runs";
import { realSettingsDb, type SettingsDb } from "./db/supa-settings";
import { realSuppressionDb, type SuppressionDb } from "./db/supa-suppression";
import { createAnthropic, createLlmClient, type LlmClient, type MessagesApi } from "./llm/client";
import { SpendGate } from "./llm/spend-gate";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface Context {
  env: Env;
  prices: PriceTable;
  /** The SQLite cache DB only now (pages, robots_txt, token_counts, extractions) -- everything else
   * (leads, dossiers, sequences, events, runs, suppression, settings) lives in Supabase. */
  db: Db;
  /** Service-role Supabase client: bypasses RLS. Used for everything except settings writes, which
   * need a request-scoped client instead so Postgres's own owner-only RLS applies (see server/app.ts). */
  supa: SupabaseClient;
  leadsDb: LeadsDb;
  sequencesDb: SequencesDb;
  eventsDb: EventsDb;
  runsDb: RunsDb;
  suppressionDb: SuppressionDb;
  settingsDb: SettingsDb;
  gate: SpendGate;
  llm: LlmClient;
}

export interface BootstrapOptions {
  /** Wraps the Anthropic client (the live CLI records model calls for regression fixtures). */
  wrapApi?: (api: MessagesApi) => MessagesApi;
}

/** Validates config, loads prices, opens the DBs. Throws with a readable message on any problem. */
export function bootstrap(opts: BootstrapOptions = {}): Context {
  const env = loadEnv();
  const prices = loadPriceTable(fromRoot(env.PRICES_PATH));
  assertPricesFor(prices, [env.MODEL_EXTRACT, env.MODEL_WRITE]);
  const db = openDb(fromRoot(env.DB_PATH));
  const supa = createServiceRoleClient(env);
  const runsDb = realRunsDb(supa);
  const gate = new SpendGate(runsDb, env.MONTHLY_SPEND_CAP_USD);
  const llm = createLlmClient({
    api: (opts.wrapApi ?? ((a: MessagesApi) => a))(createAnthropic(env.ANTHROPIC_API_KEY)),
    runsDb,
    prices,
    gate,
    leadTokenBudget: env.LEAD_TOKEN_BUDGET,
  });
  return {
    env,
    prices,
    db,
    supa,
    leadsDb: realLeadsDb(supa),
    sequencesDb: realSequencesDb(supa),
    eventsDb: realEventsDb(supa),
    runsDb,
    suppressionDb: realSuppressionDb(supa),
    settingsDb: realSettingsDb(supa),
    gate,
    llm,
  };
}

/** Entry-point wrapper: print config errors cleanly (no stack trace, no secret values) and exit. */
export function bootstrapOrExit(opts: BootstrapOptions = {}): Context {
  try {
    return bootstrap(opts);
  } catch (err) {
    console.error(`\n[clearpath] Startup failed.\n${(err as Error).message}\n`);
    process.exit(1);
  }
}
