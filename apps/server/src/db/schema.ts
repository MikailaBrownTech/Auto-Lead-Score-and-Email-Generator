import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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

export type RunRow = typeof runs.$inferSelect;
export type NewRunRow = typeof runs.$inferInsert;
