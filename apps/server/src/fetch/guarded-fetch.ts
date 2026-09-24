import { isIP } from "node:net";
import { BlockedUrlError, checkUrl, isBlockedAddress } from "./ip-guard";
import type { HttpTransport, ResolvedAddress, Resolver } from "./transport";

export const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type FetchPurpose = "html" | "robots" | "sitemap";

export type FailureCategory = "blocked" | "robots" | "dns" | "network" | "http" | "type" | "redirects";

export type FetchOutcome =
  | {
      ok: true;
      requestedUrl: string;
      finalUrl: string;
      status: number;
      contentType: string;
      body: Buffer;
      truncated: boolean;
      hops: string[];
    }
  | {
      ok: false;
      requestedUrl: string;
      finalUrl: string;
      status: number | null;
      category: FailureCategory;
      reason: string;
      hops: string[];
    };

export interface GuardedFetchDeps {
  resolver: Resolver;
  transport: HttpTransport;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  /**
   * Called before every hop (including redirects) once the target is known to be safe: waits for the
   * rate limiter and checks robots.txt. Returning a string refuses the hop with that reason.
   */
  beforeRequest?: (url: URL) => Promise<string | null>;
}

const ACCEPT: Record<FetchPurpose, string> = {
  html: "text/html,application/xhtml+xml;q=0.9",
  robots: "text/plain,*/*;q=0.1",
  sitemap: "application/xml,text/xml;q=0.9,*/*;q=0.1",
};

/** Resolves and vets every address; all must be public, and the first one is used. */
async function resolveSafely(url: URL, resolver: Resolver): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (family) return { address: host, family: family === 6 ? 6 : 4 };
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw Object.assign(new Error(`DNS lookup failed for ${host}: ${(err as Error).message}`), { category: "dns" });
  }
  if (addresses.length === 0) throw Object.assign(new Error(`${host} has no addresses`), { category: "dns" });
  const bad = addresses.find((a) => isBlockedAddress(a.address));
  if (bad) throw new BlockedUrlError(`${host} resolves to private or reserved address ${bad.address}`);
  return addresses[0]!;
}

function mediaType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

/**
 * GET with the SSRF guard applied on every hop: URL rules, DNS resolution, address vetting, and a
 * connection pinned to the vetted address. Redirects are followed manually (max 5), each one re-checked.
 * For purpose "html" only 200 text/html bodies are read; anything else is released unread.
 */
export async function guardedFetch(
  input: string,
  purpose: FetchPurpose,
  deps: GuardedFetchDeps,
): Promise<FetchOutcome> {
  const hops: string[] = [];
  let current = input;
  const fail = (category: FailureCategory, reason: string, status: number | null = null): FetchOutcome => ({
    ok: false,
    requestedUrl: input,
    finalUrl: current,
    status,
    category,
    reason,
    hops,
  });

  for (let redirects = 0; ; redirects++) {
    hops.push(current);
    let url: URL;
    let address: ResolvedAddress;
    try {
      url = checkUrl(current);
      address = await resolveSafely(url, deps.resolver);
    } catch (err) {
      const category = err instanceof BlockedUrlError ? "blocked" : ((err as { category?: FailureCategory }).category ?? "network");
      return fail(category, (err as Error).message);
    }

    const refusal = deps.beforeRequest ? await deps.beforeRequest(url) : null;
    if (refusal) return fail("robots", refusal);

    let res;
    try {
      res = await deps.transport({
        url,
        address,
        timeoutMs: deps.timeoutMs,
        headers: {
          "user-agent": deps.userAgent,
          accept: ACCEPT[purpose],
          "accept-language": "en-US,en;q=0.8",
        },
      });
    } catch (err) {
      return fail("network", `request failed: ${(err as Error).message}`);
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      await res.discard();
      const location = res.headers.location;
      if (!location) return fail("http", `HTTP ${res.status} without a Location header`, res.status);
      if (redirects >= MAX_REDIRECTS) return fail("redirects", `more than ${MAX_REDIRECTS} redirects`, res.status);
      try {
        current = new URL(location, url).toString();
      } catch {
        return fail("http", `invalid redirect target ${location}`, res.status);
      }
      continue;
    }

    const contentType = res.headers["content-type"] ?? "";
    if (purpose === "html") {
      if (res.status !== 200) {
        await res.discard();
        return fail("http", `HTTP ${res.status}`, res.status);
      }
      if (mediaType(contentType) !== "text/html") {
        await res.discard();
        return fail("type", `skipped: content type ${contentType || "(none)"} is not text/html`, res.status);
      }
    } else if (purpose === "sitemap") {
      if (res.status !== 200) {
        await res.discard();
        return fail("http", `HTTP ${res.status}`, res.status);
      }
      if (!/xml/.test(mediaType(contentType))) {
        await res.discard();
        return fail("type", `skipped: content type ${contentType || "(none)"} is not XML`, res.status);
      }
    } else if (res.status < 200 || res.status >= 300 || !mediaType(contentType).startsWith("text/")) {
      // robots.txt: callers only need the status for non-2xx or non-text answers.
      await res.discard();
      return { ok: true, requestedUrl: input, finalUrl: current, status: res.status, contentType, body: Buffer.alloc(0), truncated: false, hops };
    }

    try {
      const { body, truncated } = await res.readBody(deps.maxBytes);
      return { ok: true, requestedUrl: input, finalUrl: current, status: res.status, contentType, body, truncated, hops };
    } catch (err) {
      return fail("network", `reading body failed: ${(err as Error).message}`, res.status);
    }
  }
}

/** Decodes a body using the charset from Content-Type, falling back to UTF-8. */
export function decodeBody(body: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}
