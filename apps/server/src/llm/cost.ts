import type { ModelPrice } from "../config/prices";

/** The usage fields the Messages API returns that affect cost. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
}

const PER_TOKEN = 1 / 1_000_000;

/**
 * Cost in USD for one response. `input_tokens` is the uncached remainder only, so each
 * token category is billed once at its own rate. When the API omits the 5m/1h breakdown,
 * cache writes are billed at the 1h rate (the higher one) so the logged cost never undercounts.
 */
export function computeCostUsd(usage: UsageLike, price: ModelPrice): number {
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTotal = usage.cache_creation_input_tokens ?? 0;
  const w5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? null;
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? null;

  let writeCost: number;
  if (w5m !== null || w1h !== null) {
    const known5m = w5m ?? 0;
    const known1h = w1h ?? 0;
    const unattributed = Math.max(0, cacheWriteTotal - known5m - known1h);
    writeCost = known5m * price.cache_write_5m + (known1h + unattributed) * price.cache_write_1h;
  } else {
    writeCost = cacheWriteTotal * price.cache_write_1h;
  }

  return (
    (usage.input_tokens * price.input +
      cacheRead * price.cache_read +
      writeCost +
      usage.output_tokens * price.output) *
    PER_TOKEN
  );
}

/**
 * Upper bound on what a call can cost before it is sent: every input token priced at the most
 * expensive input rate (a 1h cache write) and the full max_tokens of output.
 */
export function worstCaseCostUsd(maxInputTokens: number, maxOutputTokens: number, price: ModelPrice): number {
  const inputRate = Math.max(price.input, price.cache_write_5m, price.cache_write_1h, price.cache_read);
  return (maxInputTokens * inputRate + maxOutputTokens * price.output) * PER_TOKEN;
}
