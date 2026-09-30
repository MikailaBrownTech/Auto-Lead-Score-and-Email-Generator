import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { fromRoot } from "./paths";

const intFromString = (def: number) =>
  z.coerce.number().int().positive().default(def);

export const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z
    .string({ required_error: "is required (put it in .env, never in code)" })
    .min(1, "is required (put it in .env, never in code)")
    .refine((v) => v.startsWith("sk-ant-"), "does not look like an Anthropic API key (expected sk-ant-...)")
    .refine((v) => !v.includes("your-real-key"), "is still the placeholder from .env.example"),
  MODEL_EXTRACT: z.string().min(1, "is required (small model that reads raw page text)"),
  MODEL_WRITE: z.string().min(1, "is required (stronger model that sees only the dossier)"),
  MONTHLY_SPEND_CAP_USD: z.coerce
    .number({ invalid_type_error: "must be a number of US dollars" })
    .positive("must be greater than 0"),
  MAX_TOKENS_PER_PAGE: intFromString(6000),
  MAX_INPUT_TOKENS_PER_LEAD: intFromString(30000),
  /** Total tokens (input + cache + output) all calls for one lead may use before it is marked budget_exceeded. */
  LEAD_TOKEN_BUDGET: intFromString(60000),
  QUEUE_CONCURRENCY: intFromString(2),
  PORT: intFromString(8787),
  /** Browser origins allowed to call the API (the Vite dev server). The server's own origin is always allowed. */
  WEB_ORIGINS: z
    .string()
    .default("http://localhost:5173,http://127.0.0.1:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),
  /** Public page describing this crawler; appears in the user agent: ClearPathLeadConsole/0.1 (+CONTACT_URL). */
  CONTACT_URL: z
    .string({ required_error: "is required (a public URL identifying the crawler, e.g. your site's contact page)" })
    .url("must be a full URL, e.g. https://www.clearpathsecure.com/contact")
    .refine((u) => /^https?:\/\//.test(u), "must start with http:// or https://"),
  FETCH_TIMEOUT_MS: intFromString(15_000),
  /** Bodies larger than this are cut off and marked truncated. */
  FETCH_MAX_BYTES: intFromString(2_000_000),
  /** Fetched pages and robots.txt answers are reused for this many days before being fetched again. */
  PAGE_CACHE_DAYS: intFromString(7),
  DB_PATH: z.string().default("data/clearpath.db"),
  PRICES_PATH: z.string().default("config/prices.json"),

  /**
   * Same Supabase project as the companion clearpath-proposal-generator app (its profiles table,
   * is_owner(), and role model are reused as-is -- never redefined here).
   */
  SUPABASE_URL: z
    .string({ required_error: "is required (Project Settings -> API in the Supabase dashboard; the same project the proposal-generator app uses)" })
    .url("must be a full URL, e.g. https://pqejkprfilamahyfvtqf.supabase.co"),
  SUPABASE_ANON_KEY: z.string({ required_error: "is required (Project Settings -> API)" }).min(1, "is required (Project Settings -> API)"),
  /** Bypasses RLS. Server-only: never sent to the browser, never used on a path a signed-in user's own request reaches unscoped. */
  SUPABASE_SERVICE_ROLE_KEY: z.string({ required_error: "is required (Project Settings -> API; keep this out of the browser)" }).min(1, "is required (Project Settings -> API)"),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvError extends Error {
  override name = "EnvError";
}

/**
 * Validates configuration. Error messages name the variable and the problem, never the value,
 * so a bad key is not echoed to the terminal.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new EnvError(
    `Invalid configuration in .env:\n${lines.join("\n")}\nSee .env.example for the full list of settings.`,
  );
}

/** Loads the repo-root .env (without overriding real environment variables) and validates it. */
export function loadEnv(): Env {
  loadDotenv({ path: fromRoot(".env"), quiet: true });
  return parseEnv(process.env);
}
