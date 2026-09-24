import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const CALL_TYPES = ["smoke", "extract", "extract_retry", "write", "judge"] as const;
export type CallType = (typeof CALL_TYPES)[number];

/** One row per Anthropic API call (successful or failed). Cost is computed locally from config/prices.json. */
export const runs = sqliteTable(
  "runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
    model: text("model").notNull(),
    callType: text("call_type", { enum: CALL_TYPES }).notNull(),
    leadId: text("lead_id"),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    /** Total cache_creation_input_tokens; the 5m/1h split is kept when the API reports it. */
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    cacheWrite5mTokens: integer("cache_write_5m_tokens"),
    cacheWrite1hTokens: integer("cache_write_1h_tokens"),
    /** Fingerprint of model + tools + system when the call requested caching (see llm/client.ts prefixKey). */
    prefixKey: text("prefix_key"),
    costUsd: real("cost_usd").notNull().default(0),
    stopReason: text("stop_reason"),
    messageId: text("message_id"),
    error: text("error"),
  },
  (t) => [index("runs_created_at_idx").on(t.createdAt), index("runs_lead_id_idx").on(t.leadId), index("runs_prefix_key_idx").on(t.prefixKey)],
);

export const LEAD_STATUSES = ["new", "researching", "extracted", "budget_exceeded", "failed"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  inputUrl: text("input_url"),
  source: text("source", { enum: ["web", "pasted"] }).notNull(),
  status: text("status", { enum: LEAD_STATUSES }).notNull().default("new"),
  dossierJson: text("dossier_json"),
  score: integer("score"),
  tier: text("tier", { enum: ["A", "B", "C"] }),
  error: text("error"),
  createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  updatedAt: text("updated_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
});

/** Fetched and cleaned pages. Re-used on reruns within PAGE_CACHE_DAYS instead of re-fetching. */
export const pages = sqliteTable(
  "pages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    requestedUrl: text("requested_url").notNull(),
    url: text("url").notNull(),
    contentType: text("content_type").notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    hiddenText: text("hidden_text").notNull(),
    linksJson: text("links_json").notNull(),
    textSha256: text("text_sha256").notNull(),
    rawSha256: text("raw_sha256").notNull(),
    bytes: integer("bytes").notNull(),
    truncated: integer("truncated", { mode: "boolean" }).notNull(),
    nearEmpty: integer("near_empty", { mode: "boolean" }).notNull(),
    fetchedAt: text("fetched_at").notNull(),
  },
  (t) => [index("pages_requested_url_idx").on(t.requestedUrl), index("pages_url_hash_idx").on(t.url, t.rawSha256)],
);

/** robots.txt answers (2xx body or 4xx status only; 5xx/unreachable are never cached). */
export const robotsTxt = sqliteTable("robots_txt", {
  origin: text("origin").primaryKey(),
  status: integer("status").notNull(),
  body: text("body").notNull(),
  fetchedAt: text("fetched_at").notNull(),
});

/** Token counts from the count_tokens API, keyed by text hash and model, so unchanged text is never recounted. */
export const tokenCounts = sqliteTable(
  "token_counts",
  {
    textSha256: text("text_sha256").notNull(),
    model: text("model").notNull(),
    tokens: integer("tokens").notNull(),
  },
  (t) => [primaryKey({ columns: [t.textSha256, t.model] })],
);

/** Verified extraction results keyed by model + prompt + tool schema + exact page text sent. */
export const extractions = sqliteTable(
  "extractions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: text("lead_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    model: text("model").notNull(),
    resultJson: text("result_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`),
  },
  (t) => [index("extractions_cache_key_idx").on(t.cacheKey)],
);

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
