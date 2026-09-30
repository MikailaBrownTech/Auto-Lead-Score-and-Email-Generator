import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallType } from "../db/schema";

/** The cost/token ledger (Supabase `runs`), in the app's own field names (camelCase, matching the old SQLite shape). */
export interface NewRunRow {
  model: string;
  callType: CallType;
  leadId: string | null;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  prefixKey?: string | null;
  costUsd?: number;
  stopReason?: string | null;
  messageId?: string | null;
  error?: string | null;
}

export interface RunRow extends Required<Omit<NewRunRow, "cacheWrite5mTokens" | "cacheWrite1hTokens" | "prefixKey" | "stopReason" | "messageId" | "error">> {
  id: number;
  createdAt: string;
  cacheWrite5mTokens: number | null;
  cacheWrite1hTokens: number | null;
  prefixKey: string | null;
  stopReason: string | null;
  messageId: string | null;
  error: string | null;
}

/** Everything the app does against the runs table. Aggregates are summed in JS over a filtered row
 * set (never a PostgREST aggregate function, whose availability isn't guaranteed) -- fine at this
 * app's scale (hundreds, not millions, of rows); a Postgres RPC would be the move if that changes. */
export interface RunsDb {
  insert(row: NewRunRow): Promise<void>;
  /** The newest run's id (0 if there are none yet) -- the start mark for a research run's per-lead budget. */
  maxId(): Promise<number>;
  /** Tokens a lead has used across all logged calls after `sinceRunId` (0 = the lead's whole history). */
  tokensForLead(leadId: string, sinceRunId: number): Promise<number>;
  /** Total cost_usd for createdAt in [startIso, endIso). */
  costInRange(startIso: string, endIso: string): Promise<number>;
  /** Total cost_usd per lead (leads with 0 spend are simply absent). */
  costByLead(): Promise<Map<string, number>>;
  /** Every "ok" run with a prefix_key, newest first -- cache-health.ts groups and analyzes these itself. */
  listOkWithPrefixKey(): Promise<RunRow[]>;
  /** Every run logged after `sinceRunId` (0 = all of them), oldest first -- the CLI scripts' own
   * per-lead/per-call-type cost and error breakdowns (filtered and grouped in JS, same reasoning as
   * the other aggregates here). */
  listSince(sinceRunId: number): Promise<RunRow[]>;
}

function toDbRow(row: NewRunRow): Record<string, unknown> {
  return {
    model: row.model,
    call_type: row.callType,
    lead_id: row.leadId,
    status: row.status,
    input_tokens: row.inputTokens ?? 0,
    output_tokens: row.outputTokens ?? 0,
    cache_read_tokens: row.cacheReadTokens ?? 0,
    cache_write_tokens: row.cacheWriteTokens ?? 0,
    cache_write_5m_tokens: row.cacheWrite5mTokens ?? null,
    cache_write_1h_tokens: row.cacheWrite1hTokens ?? null,
    prefix_key: row.prefixKey ?? null,
    cost_usd: row.costUsd ?? 0,
    stop_reason: row.stopReason ?? null,
    message_id: row.messageId ?? null,
    error: row.error ?? null,
  };
}

function fromDbRow(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as number,
    createdAt: r.created_at as string,
    model: r.model as string,
    callType: r.call_type as CallType,
    leadId: (r.lead_id as string | null) ?? null,
    status: r.status as "ok" | "error",
    inputTokens: (r.input_tokens as number) ?? 0,
    outputTokens: (r.output_tokens as number) ?? 0,
    cacheReadTokens: (r.cache_read_tokens as number) ?? 0,
    cacheWriteTokens: (r.cache_write_tokens as number) ?? 0,
    cacheWrite5mTokens: (r.cache_write_5m_tokens as number | null) ?? null,
    cacheWrite1hTokens: (r.cache_write_1h_tokens as number | null) ?? null,
    prefixKey: (r.prefix_key as string | null) ?? null,
    costUsd: (r.cost_usd as number) ?? 0,
    stopReason: (r.stop_reason as string | null) ?? null,
    messageId: (r.message_id as string | null) ?? null,
    error: (r.error as string | null) ?? null,
  };
}

export function realRunsDb(supa: SupabaseClient): RunsDb {
  return {
    async insert(row) {
      const { error } = await supa.from("runs").insert(toDbRow(row));
      if (error) throw new Error(`Could not log the run: ${error.message}`);
    },
    async maxId() {
      const { data, error } = await supa.from("runs").select("id").order("id", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`Could not read the last run id: ${error.message}`);
      return (data?.id as number | undefined) ?? 0;
    },
    async tokensForLead(leadId, sinceRunId) {
      const { data, error } = await supa
        .from("runs")
        .select("input_tokens,output_tokens,cache_read_tokens,cache_write_tokens")
        .eq("lead_id", leadId)
        .gt("id", sinceRunId);
      if (error) throw new Error(`Could not read the lead's token usage: ${error.message}`);
      return (data ?? []).reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0), 0);
    },
    async costInRange(startIso, endIso) {
      const { data, error } = await supa.from("runs").select("cost_usd").gte("created_at", startIso).lt("created_at", endIso);
      if (error) throw new Error(`Could not read spend for this month: ${error.message}`);
      return (data ?? []).reduce((s, r) => s + (r.cost_usd ?? 0), 0);
    },
    async costByLead() {
      const { data, error } = await supa.from("runs").select("lead_id,cost_usd").not("lead_id", "is", null);
      if (error) throw new Error(`Could not read cost per lead: ${error.message}`);
      const out = new Map<string, number>();
      for (const r of data ?? []) {
        const id = r.lead_id as string;
        out.set(id, (out.get(id) ?? 0) + (r.cost_usd ?? 0));
      }
      return out;
    },
    async listOkWithPrefixKey() {
      const { data, error } = await supa.from("runs").select("*").eq("status", "ok").not("prefix_key", "is", null).order("id", { ascending: false });
      if (error) throw new Error(`Could not read cache health: ${error.message}`);
      return (data ?? []).map(fromDbRow);
    },
    async listSince(sinceRunId) {
      const { data, error } = await supa.from("runs").select("*").gt("id", sinceRunId).order("id", { ascending: true });
      if (error) throw new Error(`Could not list runs: ${error.message}`);
      return (data ?? []).map(fromDbRow);
    },
  };
}
