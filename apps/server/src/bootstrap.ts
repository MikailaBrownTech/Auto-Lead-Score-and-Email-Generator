import { loadEnv, type Env } from "./config/env";
import { fromRoot } from "./config/paths";
import { assertPricesFor, loadPriceTable, type PriceTable } from "./config/prices";
import { openDb, type Db } from "./db/client";
import { createAnthropic, createLlmClient, type LlmClient, type MessagesApi } from "./llm/client";
import { SpendGate } from "./llm/spend-gate";

export interface Context {
  env: Env;
  prices: PriceTable;
  db: Db;
  gate: SpendGate;
  llm: LlmClient;
}

export interface BootstrapOptions {
  /** Wraps the Anthropic client (the live CLI records model calls for regression fixtures). */
  wrapApi?: (api: MessagesApi) => MessagesApi;
}

/** Validates config, loads prices, opens the DB. Throws with a readable message on any problem. */
export function bootstrap(opts: BootstrapOptions = {}): Context {
  const env = loadEnv();
  const prices = loadPriceTable(fromRoot(env.PRICES_PATH));
  assertPricesFor(prices, [env.MODEL_EXTRACT, env.MODEL_WRITE]);
  const db = openDb(fromRoot(env.DB_PATH));
  const gate = new SpendGate(db, env.MONTHLY_SPEND_CAP_USD);
  const llm = createLlmClient({
    api: (opts.wrapApi ?? ((a: MessagesApi) => a))(createAnthropic(env.ANTHROPIC_API_KEY)),
    db,
    prices,
    gate,
    leadTokenBudget: env.LEAD_TOKEN_BUDGET,
  });
  return { env, prices, db, gate, llm };
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
