import crypto from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gt, max, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { runs, type CallType } from "../db/schema";
import { priceFor, type PriceTable } from "../config/prices";
import { computeCostUsd, worstCaseCostUsd } from "./cost";
import { withBackoff, type BackoffOptions } from "./retry";
import type { SpendGate } from "./spend-gate";

export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(
    readonly leadId: string,
    readonly usedTokens: number,
    readonly projectedTokens: number,
    readonly budgetTokens: number,
  ) {
    super(
      `Lead ${leadId} has used ${usedTokens} tokens; this call could add up to ${projectedTokens - usedTokens}, ` +
        `exceeding its ${budgetTokens}-token budget. No API call was made.`,
    );
  }
}

/** The subset of the SDK client this wrapper needs; tests pass a fake. */
export interface MessagesApi {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
    countTokens(params: Anthropic.MessageCountTokensParams): Promise<Anthropic.MessageTokensCount>;
  };
}

export interface CallMeta {
  callType: CallType;
  leadId?: string;
  /**
   * The per-lead budget covers one research run: only calls logged after this runs.id count.
   * Omitted = the lead's whole history.
   */
  budgetSinceRunId?: number;
}

export interface LlmClientDeps {
  api: MessagesApi;
  db: Db;
  prices: PriceTable;
  gate: SpendGate;
  leadTokenBudget: number;
  backoff?: BackoffOptions;
}

export interface CallResult {
  message: Anthropic.Message;
  costUsd: number;
}

/** Per-request timeout. A timed-out call is logged as an error and its reservation released. */
export const REQUEST_TIMEOUT_MS = 120_000;

/** Creates the real SDK client. SDK-level retries are off so withBackoff is the only retry layer. */
export function createAnthropic(apiKey: string): MessagesApi {
  return new Anthropic({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
}

/** The newest runs.id, used as the start mark for a research run's per-lead budget. */
export function lastRunId(db: Db): number {
  return db.select({ id: max(runs.id) }).from(runs).get()?.id ?? 0;
}

/** Tokens a lead has consumed across all logged calls, from API usage numbers (every category counts). */
export function leadTokensUsed(db: Db, leadId: string, sinceRunId = 0): number {
  const row = db
    .select({
      total: sql<number>`coalesce(sum(${runs.inputTokens} + ${runs.outputTokens} + ${runs.cacheReadTokens} + ${runs.cacheWriteTokens}), 0)`,
    })
    .from(runs)
    .where(and(eq(runs.leadId, leadId), gt(runs.id, sinceRunId)))
    .get();
  return row?.total ?? 0;
}

function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl);
  return typeof value === "object" && value !== null && "cache_control" in value && value.cache_control != null;
}

/**
 * Fingerprint of the static prefix (model + tools + system) when the request asks for caching;
 * null otherwise. Calls sharing a key should see cache reads after the first one.
 */
export function prefixKey(params: Anthropic.MessageCreateParamsNonStreaming): string | null {
  const requested =
    params.cache_control != null || hasCacheControl(params.system) || hasCacheControl(params.tools);
  if (!requested) return null;
  const material = JSON.stringify([params.model, params.tools ?? null, params.system ?? null]);
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function countParams(params: Anthropic.MessageCreateParamsNonStreaming): Anthropic.MessageCountTokensParams {
  const out: Anthropic.MessageCountTokensParams = { model: params.model, messages: params.messages };
  if (params.system !== undefined) out.system = params.system;
  if (params.tools !== undefined) out.tools = params.tools as Anthropic.MessageCountTokensParams["tools"];
  if (params.tool_choice !== undefined) out.tool_choice = params.tool_choice;
  if (params.thinking !== undefined) out.thinking = params.thinking;
  if (params.output_config !== undefined) out.output_config = params.output_config;
  if (params.cache_control !== undefined) out.cache_control = params.cache_control;
  return out;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `${err.status ?? "-"} ${err.name}: ${err.message}`.slice(0, 500);
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

/**
 * The only path to the Anthropic API. Every call:
 *   1. counts its input tokens with the API's own tokenizer for that model (count_tokens is free;
 *      it includes tool definitions and the tool-use system prompt),
 *   2. refuses if the lead's used tokens + this input + max_tokens would exceed its budget,
 *   3. reserves the worst-case cost against the monthly cap (refuses if it would not fit),
 *   4. retries 429/529 with backoff,
 *   5. logs actual usage and cost to `runs`, then releases the reservation, so the cap is
 *      reconciled to actual spend. Errors and timeouts are logged at zero cost and also release.
 */
export function createLlmClient(deps: LlmClientDeps) {
  const { api, db, prices, gate, leadTokenBudget } = deps;

  async function call(meta: CallMeta, params: Anthropic.MessageCreateParamsNonStreaming): Promise<CallResult> {
    const price = priceFor(prices, params.model);
    const { input_tokens: inputTokens } = await withBackoff(
      () => api.messages.countTokens(countParams(params)),
      deps.backoff,
    );

    if (meta.leadId) {
      const used = leadTokensUsed(db, meta.leadId, meta.budgetSinceRunId ?? 0);
      const projected = used + inputTokens + params.max_tokens;
      if (projected > leadTokenBudget) {
        throw new BudgetExceededError(meta.leadId, used, projected, leadTokenBudget);
      }
    }

    const reservation = gate.reserve(worstCaseCostUsd(inputTokens, params.max_tokens, price));
    const base = {
      model: params.model,
      callType: meta.callType,
      leadId: meta.leadId ?? null,
      prefixKey: prefixKey(params),
    };

    try {
      const message = await withBackoff(() => api.messages.create(params), deps.backoff);
      const usage = message.usage;
      const costUsd = computeCostUsd(usage, price);
      db.insert(runs)
        .values({
          ...base,
          status: "ok",
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          cacheWrite5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
          cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
          costUsd,
          stopReason: message.stop_reason ?? null,
          messageId: message.id,
        })
        .run();
      return { message, costUsd };
    } catch (err) {
      db.insert(runs).values({ ...base, status: "error", error: describeError(err) }).run();
      throw err;
    } finally {
      reservation.release();
    }
  }

  /** Exact token count of a piece of text for a model, from the count_tokens API (free; not logged as spend). */
  async function countText(model: string, text: string): Promise<number> {
    const r = await withBackoff(
      () => api.messages.countTokens({ model, messages: [{ role: "user", content: text }] }),
      deps.backoff,
    );
    return r.input_tokens;
  }

  return { call, countText };
}

export type LlmClient = ReturnType<typeof createLlmClient>;
