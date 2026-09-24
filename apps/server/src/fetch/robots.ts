import robotsParser from "robots-parser";
import { decodeBody, guardedFetch, type GuardedFetchDeps } from "./guarded-fetch";
import type { HostRateLimiter } from "./rate-limit";

/** Product token matched against User-agent lines in robots.txt. */
export const ROBOTS_TOKEN = "ClearPathLeadConsole";

/** Crawl-delay values above this are capped (seconds). */
const MAX_CRAWL_DELAY_S = 30;

type RobotsState =
  | { kind: "rules"; allows: (url: string) => boolean }
  | { kind: "missing" } // 4xx: no restrictions
  | { kind: "unavailable"; reason: string }; // 5xx or unreachable: disallow everything this run

export interface RobotsDecision {
  allowed: boolean;
  reason?: string;
}

/**
 * robots.txt per origin, fetched once per run through the same SSRF guard and rate limiter.
 *  - 2xx text: parsed; rules for our token (or *) apply.
 *  - 4xx: treated as "no robots.txt", everything allowed.
 *  - 5xx, network error, blocked, or too many redirects: the whole origin is disallowed for this run,
 *    and the reason is reported so it lands in the dossier's failures.
 */
export class RobotsPolicy {
  private readonly cache = new Map<string, Promise<RobotsState>>();
  /** One message per origin that was unavailable, for the dossier failures list. */
  readonly failures: string[] = [];

  constructor(
    private readonly fetchDeps: Omit<GuardedFetchDeps, "beforeRequest">,
    private readonly limiter: HostRateLimiter,
  ) {}

  private load(origin: string): Promise<RobotsState> {
    let state = this.cache.get(origin);
    if (!state) {
      state = this.fetchRobots(origin);
      this.cache.set(origin, state);
    }
    return state;
  }

  private async fetchRobots(origin: string): Promise<RobotsState> {
    const robotsUrl = `${origin}/robots.txt`;
    const outcome = await guardedFetch(robotsUrl, "robots", {
      ...this.fetchDeps,
      beforeRequest: async (url) => {
        await this.limiter.acquire(url.hostname);
        return null;
      },
    });
    const unavailable = (why: string): RobotsState => {
      const reason = `robots.txt for ${origin} unavailable (${why}); site treated as disallowed for this run`;
      this.failures.push(reason);
      return { kind: "unavailable", reason };
    };
    if (!outcome.ok) return unavailable(outcome.reason);
    if (outcome.status >= 500) return unavailable(`HTTP ${outcome.status}`);
    if (outcome.status >= 400) return { kind: "missing" };
    if (outcome.status < 200 || outcome.status >= 300) return unavailable(`HTTP ${outcome.status}`);

    const text = outcome.body.length > 0 ? decodeBody(outcome.body, outcome.contentType) : "";
    const robots = robotsParser(robotsUrl, text);
    const delay = robots.getCrawlDelay(ROBOTS_TOKEN);
    if (typeof delay === "number" && delay > 0) {
      this.limiter.setInterval(new URL(origin).hostname, Math.min(delay, MAX_CRAWL_DELAY_S) * 1000);
    }
    // robots-parser returns undefined for URLs outside this origin; treat that as not allowed.
    return { kind: "rules", allows: (url) => robots.isAllowed(url, ROBOTS_TOKEN) === true };
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
