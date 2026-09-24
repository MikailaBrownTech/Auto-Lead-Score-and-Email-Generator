import type { PageKind } from "@clearpath/shared";
import { cleanHtml, sha256 } from "./clean";
import { decodeBody, guardedFetch, type FetchOutcome, type GuardedFetchDeps } from "./guarded-fetch";
import { checkUrl } from "./ip-guard";
import { HostRateLimiter } from "./rate-limit";
import { RobotsPolicy } from "./robots";
import { selectSubpages } from "./select";
import type { HttpTransport, Resolver } from "./transport";

/** A page actually fetched with HTTP 200 and Content-Type text/html. Only these go into pages_opened. */
export interface FetchedPage {
  requestedUrl: string;
  /** Final URL after redirects; this is the evidence_url for facts from this page. */
  url: string;
  kind: PageKind;
  httpStatus: 200;
  contentType: string;
  title: string;
  text: string;
  hiddenText: string;
  textSha256: string;
  /** Hash of the raw response body (the page-cache key in Milestone 3). */
  rawSha256: string;
  bytes: number;
  /** True when the body hit the size cap and was cut off. */
  truncated: boolean;
  nearEmpty: boolean;
  fetchedAt: string;
}

export interface SiteFetchResult {
  inputUrl: string;
  homeUrl: string | null;
  domain: string | null;
  pages: FetchedPage[];
  failures: string[];
}

export interface SiteFetchDeps {
  resolver: Resolver;
  transport: HttpTransport;
  /** "ClearPathLeadConsole/0.1 (+CONTACT_URL)" */
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  skipPatterns: RegExp[];
  limiter?: HostRateLimiter;
  now?: () => Date;
  /**
   * Optional renderer for JavaScript-heavy pages (Playwright). Not wired up yet; when absent, a
   * near-empty page is recorded in failures instead.
   */
  renderJs?: (url: string) => Promise<string | null>;
}

export function userAgentFor(contactUrl: string): string {
  return `ClearPathLeadConsole/0.1 (+${contactUrl})`;
}

/** Accepts "example.com", "www.example.com/about", or a full URL; defaults to https. */
export function normalizeInputUrl(input: string): string {
  const trimmed = input.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function describeFailure(label: string, outcome: Extract<FetchOutcome, { ok: false }>): string {
  const where = outcome.finalUrl !== outcome.requestedUrl ? ` (at ${outcome.finalUrl})` : "";
  return `${label} ${outcome.requestedUrl}: ${outcome.reason}${where}`;
}

/**
 * Fetches the homepage plus up to five relevant subpages. Obeys robots.txt, 1 request/second/host,
 * the SSRF guard on every hop, and only keeps 200 text/html pages.
 */
export async function fetchSite(input: string, deps: SiteFetchDeps): Promise<SiteFetchResult> {
  const now = deps.now ?? (() => new Date());
  const limiter = deps.limiter ?? new HostRateLimiter(1000);
  const base: Omit<GuardedFetchDeps, "beforeRequest"> = {
    resolver: deps.resolver,
    transport: deps.transport,
    userAgent: deps.userAgent,
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxBytes,
  };
  const robots = new RobotsPolicy(base, limiter);
  const fetchDeps: GuardedFetchDeps = {
    ...base,
    beforeRequest: async (url) => {
      const decision = await robots.check(url);
      if (!decision.allowed) return decision.reason ?? "disallowed by robots.txt";
      await limiter.acquire(url.hostname);
      return null;
    },
  };

  const failures: string[] = [];
  const pages: FetchedPage[] = [];
  const result = (homeUrl: string | null, domain: string | null): SiteFetchResult => ({
    inputUrl: input,
    homeUrl,
    domain,
    pages,
    failures: [...new Set([...robots.failures, ...failures])],
  });

  let start: URL;
  try {
    start = checkUrl(normalizeInputUrl(input));
  } catch (err) {
    failures.push(`input ${input}: ${(err as Error).message}`);
    return result(null, null);
  }
  const homeUrl = new URL("/", start).toString();

  async function fetchPage(url: string, kind: PageKind, label: string): Promise<{ page: FetchedPage; links: ReturnType<typeof cleanHtml>["links"] } | null> {
    const outcome = await guardedFetch(url, "html", fetchDeps);
    if (!outcome.ok) {
      failures.push(describeFailure(label, outcome));
      return null;
    }
    const html = decodeBody(outcome.body, outcome.contentType);
    let cleaned = cleanHtml(html, outcome.finalUrl);
    if (cleaned.nearEmpty && deps.renderJs) {
      const rendered = await deps.renderJs(outcome.finalUrl);
      if (rendered) cleaned = cleanHtml(rendered, outcome.finalUrl);
    }
    if (outcome.truncated) failures.push(`${label} ${outcome.finalUrl}: response over ${deps.maxBytes} bytes; truncated`);
    if (cleaned.nearEmpty) {
      failures.push(
        `${label} ${outcome.finalUrl}: almost no text (${cleaned.text.length} chars); likely needs JavaScript` +
          (deps.renderJs ? "" : " (Playwright fallback not enabled)"),
      );
    }
    return {
      page: {
        requestedUrl: url,
        url: outcome.finalUrl,
        kind,
        httpStatus: 200,
        contentType: outcome.contentType,
        title: cleaned.title,
        text: cleaned.text,
        hiddenText: cleaned.hiddenText,
        textSha256: cleaned.textSha256,
        rawSha256: sha256(outcome.body),
        bytes: outcome.body.length,
        truncated: outcome.truncated,
        nearEmpty: cleaned.nearEmpty,
        fetchedAt: now().toISOString(),
      },
      links: cleaned.links,
    };
  }

  const home = await fetchPage(homeUrl, "home", "homepage");
  if (!home) return result(homeUrl, new URL(homeUrl).hostname.replace(/^www\./, ""));
  pages.push(home.page);

  const finalHome = home.page.url;
  const domain = new URL(finalHome).hostname.toLowerCase().replace(/^www\./, "");
  for (const choice of selectSubpages(finalHome, home.links, deps.skipPatterns)) {
    const fetched = await fetchPage(choice.url, choice.kind, `${choice.kind} page`);
    if (!fetched) continue;
    if (pages.some((p) => p.url === fetched.page.url)) continue; // two links redirected to one page
    pages.push(fetched.page);
  }
  return result(finalHome, domain);
}
