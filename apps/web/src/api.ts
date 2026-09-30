import { useCallback, useEffect, useState } from "react";
import { currentAccessToken } from "./lib/supabase";

/** An API error, already in plain words (the server never sends stack traces). */
export class ApiError extends Error {
  override name = "ApiError";
}

/**
 * One plain sentence for a failed request. The guard's short codes (unauthorized, unauthenticated,
 * forbidden_origin, forbidden_host) and proxy errors become instructions; the server's own messages
 * are already plain.
 */
export function plainApiError(status: number, error: string | undefined): string {
  if (error === "unauthenticated") {
    return "Your session has expired or is no longer valid (401). Sign out and sign in again.";
  }
  if (status === 401 || error === "unauthorized") {
    return "The local server refused this request because its security token did not match (401). Restart the app with npm run app, then reload this page.";
  }
  if (status === 403 || error === "forbidden_origin" || error === "forbidden_host") {
    return "The local server refused a request from this page's address (403). Open the app at http://127.0.0.1:5173 and try again.";
  }
  if (error) return error;
  if (status >= 500) return `The local server did not answer properly (HTTP ${status}). Check that the API is running (npm run app), then try again.`;
  return `The request failed (HTTP ${status}).`;
}

/**
 * Calls the local API. The Vite dev proxy adds the per-process token; the API key never reaches the
 * browser. Errors become one readable sentence.
 */
export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await currentAccessToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers: {
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiError("The local server is not answering. Is `npm run dev:server` running?");
  }
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(plainApiError(res.status, data?.error));
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
