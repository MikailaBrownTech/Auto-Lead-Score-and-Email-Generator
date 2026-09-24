import Anthropic from "@anthropic-ai/sdk";

export interface BackoffOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; status: number | undefined }) => void;
}

/** 429 = rate limited, 529 = overloaded. Other errors (400, 401, 404, ...) are not retried. */
export function isRetryable(err: unknown): err is InstanceType<typeof Anthropic.APIError> {
  return err instanceof Anthropic.APIError && (err.status === 429 || err.status === 529);
}

function retryAfterMs(err: InstanceType<typeof Anthropic.APIError>): number | null {
  const value = err.headers?.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter; honors retry-after when the API sends it. */
export async function withBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err) || attempt >= maxRetries) throw err;
      const backoff = Math.min(cap, base * 2 ** attempt) * random();
      const delayMs = Math.min(cap, Math.max(retryAfterMs(err) ?? 0, backoff));
      opts.onRetry?.({ attempt: attempt + 1, delayMs, status: err.status });
      await sleep(delayMs);
    }
  }
}
