import robotsParser from "robots-parser";
import { decodeBody, guardedFetch, type GuardedFetchDeps } from "./guarded-fetch";
import type { HostRateLimiter } from "./rate-limit";

/** Product token matched against User-agent lines in robots.txt. */
export const ROBOTS_TOKEN = "ClearPathLeadConsole";

/** A site asking for a longer Crawl-delay than this (seconds) is skipped for the run. */
export const MAX_CRAWL_DELAY_S = 10;

type RobotsState =
  | { kind: "rules"; allows: (url: string) => boolean; sitemaps: string[] }
  | { kind: "missing" } // 4xx: no restrictions
  | { kind: "unavailable"; reason: string }; // 5xx, unreachable, or excessive Crawl-delay: disallow this run

export interface RobotsDecision {
  allowed: boolean;
  reason?: string;
}

/** A definitive robots.txt answer worth remembering: a 2xx body or a 4xx status. */
export interface RobotsSnapshot {
  status: number;
  body: string;
}

/** Optional persistent cache (SQLite) so reruns within the page-cache window do not refetch robots.txt. */
export interface RobotsStore {
  get(origin: string): RobotsSnapshot | null;
  put(origin: string, snapshot: RobotsSnapshot): void;
}

/**
 * robots.txt per origin, fetched once per run through the same SSRF guard and rate limiter.
 *  - 2xx text: parsed; rules for our token (or *) apply.
 *  - 403 or 429: the site declines automated access; nothing more is requested this run (not cached).
 *  - other 4xx: treated as "no robots.txt", everything allowed.
 *  - 5xx, network error, blocked, or too many redirects: the whole origin is disallowed for this run,
 *    and the reason is reported so it lands in the dossier's failures.
 *  - Crawl-delay over MAX_CRAWL_DELAY_S: the site is skipped for this run.
 */
export class RobotsPolicy {
  private readonly cache = new Map<string, Promise<RobotsState>>();
  /** One message per origin that was unavailable, for the dossier failures list. */
  readonly failures: string[] = [];
  /** Set when robots.txt itself answered 403 or 429: the site declines automated access (never cached). */
  declined: { url: string; status: number } | null = null;

  constructor(
    private readonly fetchDeps: Omit<GuardedFetchDeps, "beforeRequest">,
    private readonly limiter: HostRateLimiter,
    private readonly store?: RobotsStore,
  ) {}

  private load(origin: string): Promise<RobotsState> {
    let state = this.cache.get(origin);
    if (!state) {
      state = this.fetchRobots(origin);
      this.cache.set(origin, state);
    }
    return state;
  }

  private unavailable(origin: string, why: string): RobotsState {
    const reason = `robots.txt for ${origin} unavailable (${why}); site treated as disallowed for this run`;
    this.failures.push(reason);
    return { kind: "unavailable", reason };
  }

  private fromSnapshot(origin: string, snap: RobotsSnapshot): RobotsState {
    if (snap.status === 403 || snap.status === 429) {
      this.declined ??= { url: `${origin}/robots.txt`, status: snap.status };
      return this.unavailable(origin, `HTTP ${snap.status}: the site declined automated access`);
    }
    if (snap.status >= 400) return { kind: "missing" };
    const robotsUrl = `${origin}/robots.txt`;
    const robots = robotsParser(robotsUrl, snap.body);
    const delay = robots.getCrawlDelay(ROBOTS_TOKEN);
    if (typeof delay === "number" && delay > MAX_CRAWL_DELAY_S) {
      return this.unavailable(origin, `Crawl-delay ${delay}s exceeds the ${MAX_CRAWL_DELAY_S}s limit`);
    }
    if (typeof delay === "number" && delay > 0) {
      this.limiter.setInterval(new URL(origin).hostname, delay * 1000);
    }
    // robots-parser returns undefined for URLs outside this origin; treat that as not allowed.
    return { kind: "rules", allows: (url) => robots.isAllowed(url, ROBOTS_TOKEN) === true, sitemaps: robots.getSitemaps() };
  }

  private async fetchRobots(origin: string): Promise<RobotsState> {
    const stored = this.store?.get(origin);
    if (stored) return this.fromSnapshot(origin, stored);

    const outcome = await guardedFetch(`${origin}/robots.txt`, "robots", {
      ...this.fetchDeps,
      beforeRequest: async (url) => {
        await this.limiter.acquire(url.hostname);
        return null;
      },
    });
    if (!outcome.ok) return this.unavailable(origin, outcome.reason);
    if (outcome.status === 403 || outcome.status === 429) {
      this.declined ??= { url: outcome.finalUrl, status: outcome.status };
      return this.unavailable(origin, `HTTP ${outcome.status}: the site declined automated access`);
    }
    if (outcome.status >= 500) return this.unavailable(origin, `HTTP ${outcome.status}`);
    if (outcome.status >= 200 && outcome.status < 500 && !(outcome.status >= 300 && outcome.status < 400)) {
      const body = outcome.status < 300 && outcome.body.length > 0 ? decodeBody(outcome.body, outcome.contentType) : "";
      const snapshot = { status: outcome.status, body };
      this.store?.put(origin, snapshot);
      return this.fromSnapshot(origin, snapshot);
    }
    return this.unavailable(origin, `HTTP ${outcome.status}`);
  }

  /** Sitemap URLs listed in robots.txt for this origin (empty when none or robots.txt is missing). */
  async sitemapsFor(origin: string): Promise<string[]> {
    const state = await this.load(origin);
    return state.kind === "rules" ? state.sitemaps : [];
  }

  async check(url: URL): Promise<RobotsDecision> {
    const state = await this.load(url.origin);
    switch (state.kind) {
      case "missing":
        return { allowed: true };
      case "unavailable":
        return { allowed: false, reason: state.reason };
      case "rules":
        return state.allows(url.toString())
          ? { allowed: true }
          : { allowed: false, reason: `disallowed by robots.txt: ${url.pathname}` };
    }
  }
}
