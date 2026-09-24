import { useCallback, useEffect, useState } from "react";

/** An API error, already in plain words (the server never sends stack traces). */
export class ApiError extends Error {
  override name = "ApiError";
}

/**
 * Calls the local API. The Vite dev proxy adds the per-process token; the API key never reaches the
 * browser. Errors become one readable sentence.
 */
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : {},
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError("The local server is not answering. Is `npm run dev:server` running?");
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(data?.error ?? `The server answered ${res.status}.`);
  return data as T;
}

/** Loads a resource; `reload()` fetches it again. */
export function useApi<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (d: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export const usd = (n: number) => `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
