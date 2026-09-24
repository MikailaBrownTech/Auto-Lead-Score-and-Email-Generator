import type { PageKind } from "@clearpath/shared";
import { cleanHtml, sha256, type PageDate, type PageLink } from "./clean";
import { decodeBody, guardedFetch, type FetchOutcome, type GuardedFetchDeps } from "./guarded-fetch";
import { checkUrl } from "./ip-guard";
import { HostRateLimiter } from "./rate-limit";
import { RobotsPolicy, type RobotsStore } from "./robots";
import { selectSubpagesDetailed, type DiscoveredLink } from "./select";
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
  /** Full cleaned text. The keyword search runs on this, never on the token-capped copy. */
  text: string;
  hiddenText: string;
  /** Machine-readable dates in the markup (for the deterministic freshness check). */
  dates: PageDate[];
  textSha256: string;
  /** Hash of the raw response body. */
  rawSha256: string;
  bytes: number;
  /** True when the body hit the size cap and was cut off. */
  truncated: boolean;
  nearEmpty: boolean;
  fetchedAt: string;
  /** True when served from the SQLite page cache instead of the network. */
  fromCache?: boolean;
}

export interface SitemapEntry {
  loc: string;
  lastmod: string;
}

export interface SitemapResult {
  url: string;
  entries: SitemapEntry[];
  fromCache: boolean;
}

export interface LinkReport extends DiscoveredLink {
  /** For selected links: what happened when fetching. */
  fetch?: "fetched" | "cached" | string;
}

export interface SiteFetchResult {
  inputUrl: string;
  homeUrl: string | null;
  domain: string | null;
  pages: FetchedPage[];
  failures: string[];
  links: LinkReport[];
  sitemap: SitemapResult | null;
}

export interface CachedDocument {
  page: FetchedPage;
  links: PageLink[];
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
  /** Remembers robots.txt answers across runs (same window as the page cache). */
  robotsStore?: RobotsStore;
  /** Reuse recently fetched pages (and sitemaps) instead of requesting them again. */
  pageCache?: {
    get(requestedUrl: string): CachedDocument | null;
    put(page: FetchedPage, links: PageLink[]): void;
  };
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

const MAX_SITEMAP_ENTRIES = 5000;
/** Content type recorded in the page cache for "this site has no sitemap" (404/410). */
const NO_SITEMAP = "application/x-no-sitemap";

/** <url> and <sitemap> entries with a <loc> and <lastmod>. */
export function parseSitemap(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/i.exec(m[2]!)?.[1];
    const lastmod = /<lastmod>\s*([^<]+?)\s*<\/lastmod>/i.exec(m[2]!)?.[1];
    if (loc && lastmod) entries.push({ loc, lastmod });
    if (entries.length >= MAX_SITEMAP_ENTRIES) break;
  }
  return entries;
}

/**
 * Fetches the homepage plus up to five relevant subpages and one news article, and the sitemap.
 * Obeys robots.txt, 1 request/second/host, and the SSRF guard on every hop; keeps only 200 text/html
 * pages (sitemaps: 200 XML).
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
  const robots = new RobotsPolicy(base, limiter, deps.robotsStore);
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
  let links: LinkReport[] = [];
  let sitemap: SitemapResult | null = null;
  const result = (homeUrl: string | null, domain: string | null): SiteFetchResult => ({
    inputUrl: input,
    homeUrl,
    domain,
    pages,
    failures: [...new Set([...robots.failures, ...failures])],
    links,
    sitemap,
  });

  let start: URL;
  try {
    start = checkUrl(normalizeInputUrl(input));
  } catch (err) {
    failures.push(`input ${input}: ${(err as Error).message}`);
    return result(null, null);
  }
  const homeUrl = new URL("/", start).toString();

  function notePageProblems(label: string, page: FetchedPage): void {
    if (page.truncated) failures.push(`${label} ${page.url}: response over ${deps.maxBytes} bytes; truncated`);
    if (page.nearEmpty) {
      failures.push(
        `${label} ${page.url}: almost no text (${page.text.length} chars); likely needs JavaScript` +
          (deps.renderJs ? "" : " (Playwright fallback not enabled)"),
      );
    }
  }

  async function fetchPage(url: string, kind: PageKind, label: string): Promise<{ page: FetchedPage; links: PageLink[]; error?: string } | { page: null; error: string }> {
    const cached = deps.pageCache?.get(url);
    if (cached) {
      const page = { ...cached.page, kind, fromCache: true };
      notePageProblems(label, page);
      return { page, links: cached.links };
    }

    const outcome = await guardedFetch(url, "html", fetchDeps);
    if (!outcome.ok) {
      const message = describeFailure(label, outcome);
      failures.push(message);
      return { page: null, error: outcome.reason };
    }
    const html = decodeBody(outcome.body, outcome.contentType);
    let cleaned = cleanHtml(html, outcome.finalUrl);
    if (cleaned.nearEmpty && deps.renderJs) {
      const rendered = await deps.renderJs(outcome.finalUrl);
      if (rendered) cleaned = cleanHtml(rendered, outcome.finalUrl);
    }
    const fetched: { page: FetchedPage; links: PageLink[] } = {
      page: {
        requestedUrl: url,
        url: outcome.finalUrl,
        kind,
        httpStatus: 200,
        contentType: outcome.contentType,
        title: cleaned.title,
        text: cleaned.text,
        hiddenText: cleaned.hiddenText,
        dates: cleaned.dates,
        textSha256: cleaned.textSha256,
        rawSha256: sha256(outcome.body),
        bytes: outcome.body.length,
        truncated: outcome.truncated,
        nearEmpty: cleaned.nearEmpty,
        fetchedAt: now().toISOString(),
        fromCache: false,
      },
      links: cleaned.links,
    };
    notePageProblems(label, fetched.page);
    deps.pageCache?.put(fetched.page, fetched.links);
    return fetched;
  }

  /** The sitemap from robots.txt (first listed) or /sitemap.xml, through the same guards. Cached like pages. */
  async function fetchSitemap(origin: string): Promise<void> {
    const listed = (await robots.sitemapsFor(origin)).filter((u) => {
      try {
        return new URL(u).origin === origin || new URL(u).hostname.replace(/^www\./, "") === new URL(origin).hostname.replace(/^www\./, "");
      } catch {
        return false;
      }
    });
    const url = listed[0] ?? `${origin}/sitemap.xml`;
    const cached = deps.pageCache?.get(url);
    if (cached) {
      if (cached.page.contentType !== NO_SITEMAP) sitemap = { url: cached.page.url, entries: parseSitemap(cached.page.text), fromCache: true };
      return;
    }
    const outcome = await guardedFetch(url, "sitemap", fetchDeps);
    const remember = (finalUrl: string, contentType: string, xml: string, body: Buffer, truncated: boolean) =>
      deps.pageCache?.put(
        {
          requestedUrl: url,
          url: finalUrl,
          kind: "other",
          httpStatus: 200,
          contentType,
          title: "sitemap",
          text: xml,
          hiddenText: "",
          dates: [],
          textSha256: sha256(xml),
          rawSha256: sha256(body),
          bytes: body.length,
          truncated,
          nearEmpty: false,
          fetchedAt: now().toISOString(),
        },
        [],
      );
    if (!outcome.ok) {
      // A missing sitemap is common and not a problem; remember it so reruns do not ask again.
      if (outcome.status === 404 || outcome.status === 410) remember(url, NO_SITEMAP, "", Buffer.alloc(0), false);
      else failures.push(describeFailure("sitemap", outcome));
      return;
    }
    const xml = decodeBody(outcome.body, outcome.contentType);
    sitemap = { url: outcome.finalUrl, entries: parseSitemap(xml), fromCache: false };
    remember(outcome.finalUrl, outcome.contentType, xml, outcome.body, outcome.truncated);
  }

  const home = await fetchPage(homeUrl, "home", "homepage");
  if (!home.page) return result(homeUrl, new URL(homeUrl).hostname.replace(/^www\./, ""));
  pages.push(home.page);

  const finalHome = home.page.url;
  const domain = new URL(finalHome).hostname.toLowerCase().replace(/^www\./, "");
  const selection = selectSubpagesDetailed(finalHome, home.links, deps.skipPatterns);
  links = selection.discovered;
  for (const choice of selection.chosen) {
    const fetched = await fetchPage(choice.url, choice.kind, `${choice.kind} page`);
    const report = links.find((l) => l.url === choice.url);
    if (!fetched.page) {
      if (report) report.fetch = `failed: ${fetched.error}`;
      continue;
    }
    if (report) report.fetch = fetched.page.fromCache ? "cached" : "fetched";
    if (pages.some((p) => p.url === fetched.page.url)) continue; // two links redirected to one page
    pages.push(fetched.page);
  }
  await fetchSitemap(new URL(finalHome).origin);
  return result(finalHome, domain);
}
