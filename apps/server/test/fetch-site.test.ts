import { describe, expect, it } from "vitest";
import { loadScoring } from "../src/docs/loader";
import { loadSkipPatterns } from "../src/fetch/select";
import { fetchSite, normalizeInputUrl, userAgentFor, type SiteFetchDeps } from "../src/fetch/site";
import { searchSecurityMentions } from "../src/scoring/security-search";
import { scoreDossier } from "../src/scoring/score";
import { strongDossier } from "./fixtures/dossiers";
import { FakeWeb, fakeLimiter, html, PUBLIC_IP, sampleWeb } from "./fixtures/fakeweb";

const UA = userAgentFor("https://www.clearpathsecure.com/contact");
const skipPatterns = loadSkipPatterns();

function deps(web: FakeWeb, over: Partial<SiteFetchDeps> = {}) {
  const lim = fakeLimiter();
  return {
    lim,
    deps: {
      resolver: web.resolver,
      transport: web.transport,
      userAgent: UA,
      timeoutMs: 1000,
      maxBytes: 2_000_000,
      skipPatterns,
      limiter: lim.limiter,
      now: () => new Date("2026-09-23T12:00:00.000Z"),
      ...over,
    } satisfies SiteFetchDeps,
  };
}

describe("fetchSite on saved fixtures (no live network)", () => {
  it("smithtax: homepage plus allowed subpages; robots-disallowed page is skipped and reported", async () => {
    const web = sampleWeb();
    const { deps: d } = deps(web);
    const r = await fetchSite("smithtax.example", d);
    expect(r.homeUrl).toBe("https://smithtax.example/");
    expect(r.domain).toBe("smithtax.example");
    expect(r.pages.map((p) => [p.url, p.kind])).toEqual([
      ["https://smithtax.example/", "home"],
      ["https://smithtax.example/about", "about"],
      ["https://smithtax.example/services", "services"],
      ["https://smithtax.example/contact", "contact"],
      ["https://smithtax.example/privacy-policy", "privacy"],
    ]);
    expect(r.failures).toEqual([
      "team page https://smithtax.example/private/staff: disallowed by robots.txt: /private/staff",
    ]);
    // robots.txt is read before any page, and the disallowed page is never requested.
    expect(web.requests[0]!.url).toBe("https://smithtax.example/robots.txt");
    expect(web.requests.map((q) => q.url)).not.toContain("https://smithtax.example/private/staff");
  });

  it("sends the configured user agent on every request, including robots.txt", async () => {
    const web = sampleWeb();
    await fetchSite("smithtax.example", deps(web).deps);
    expect(UA).toBe("ClearPathLeadConsole/0.1 (+https://www.clearpathsecure.com/contact)");
    for (const q of web.requests) expect(q.headers["user-agent"]).toBe(UA);
  });

  it("waits 1 second between requests to the same host", async () => {
    const web = sampleWeb();
    const { deps: d, lim } = deps(web);
    await fetchSite("smithtax.example", d);
    // robots.txt + 5 pages = 6 requests to one host -> 5 waits of 1s on the fake clock.
    expect(web.requests).toHaveLength(6);
    expect(lim.sleeps).toEqual([1000, 1000, 1000, 1000, 1000]);
  });

  it("records every page with status 200, text/html, hashes, and fetch time", async () => {
    const r = await fetchSite("smithtax.example", deps(sampleWeb()).deps);
    for (const p of r.pages) {
      expect(p.httpStatus).toBe(200);
      expect(p.contentType).toMatch(/^text\/html/);
      expect(p.textSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(p.truncated).toBe(false);
      expect(p.fetchedAt).toBe("2026-09-23T12:00:00.000Z");
    }
  });

  it("follows an http -> https redirect and records the final URL", async () => {
    const r = await fetchSite("http://smithtax.example/", deps(sampleWeb()).deps);
    expect(r.pages[0]!.url).toBe("https://smithtax.example/");
    expect(r.pages[0]!.requestedUrl).toBe("http://smithtax.example/");
  });

  it("oakcpa: follows redirects, skips a PDF, and blocks a redirect into cloud metadata", async () => {
    const web = sampleWeb();
    const r = await fetchSite("https://oakcpa.example", deps(web).deps);
    expect(r.homeUrl).toBe("https://www.oakcpa.example/");
    expect(r.domain).toBe("oakcpa.example");
    expect(r.pages.map((p) => [p.url, p.kind])).toEqual([
      ["https://www.oakcpa.example/", "home"],
      ["https://www.oakcpa.example/about/", "about"],
      ["https://www.oakcpa.example/our-team", "team"],
      ["https://www.oakcpa.example/security", "security"],
    ]);
    expect(r.failures.join("\n")).toMatch(/services page https:\/\/www\.oakcpa\.example\/services: skipped: content type application\/pdf/);
    expect(r.failures.join("\n")).toMatch(/contact page .*private or reserved.*169\.254\.169\.254/);
    expect(web.requests.map((q) => q.url)).not.toContain("http://169.254.169.254/latest/meta-data/");
    // The /2025/11/ blog archive link was skipped by pattern, never requested.
    expect(web.requests.map((q) => q.url).join(" ")).not.toContain("/2025/11/");
  });

  it("pages_opened (pages) excludes everything that was not 200 text/html", async () => {
    const r = await fetchSite("https://oakcpa.example", deps(sampleWeb()).deps);
    expect(r.pages.map((p) => p.url)).not.toContain("https://www.oakcpa.example/services");
    expect(r.pages.map((p) => p.url)).not.toContain("https://www.oakcpa.example/contact");
  });

  it("brightbooks: a JavaScript-only homepage is flagged, and Crawl-delay is applied", async () => {
    const web = sampleWeb();
    const { deps: d, lim } = deps(web);
    const r = await fetchSite("brightbooks.example", d);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]!.nearEmpty).toBe(true);
    expect(r.failures[0]).toMatch(/almost no text.*likely needs JavaScript \(Playwright fallback not enabled\)/);
    expect(lim.limiter.intervalFor("brightbooks.example")).toBe(2000);
  });

  it("uses the optional JavaScript renderer when provided", async () => {
    const rendered = "<html><body><main><p>" + "BrightBooks keeps the books for forty small businesses. ".repeat(6) + "</p></main></body></html>";
    const r = await fetchSite("brightbooks.example", deps(sampleWeb(), { renderJs: async () => rendered }).deps);
    expect(r.pages[0]!.nearEmpty).toBe(false);
    expect(r.pages[0]!.text).toContain("forty small businesses");
    expect(r.failures).toEqual([]);
  });

  it("down.example: robots.txt 503 means no pages at all this run, with the reason recorded", async () => {
    const web = sampleWeb();
    const r = await fetchSite("down.example", deps(web).deps);
    expect(r.pages).toEqual([]);
    expect(r.failures.join("\n")).toMatch(/robots\.txt for https:\/\/down\.example unavailable \(HTTP 503\)/);
    expect(web.requests.map((q) => q.url)).toEqual(["https://down.example/robots.txt"]);
  });

  it("rejects unsafe input URLs before any request", async () => {
    const web = sampleWeb();
    const r = await fetchSite("http://localhost:8787/api/spend", deps(web).deps);
    expect(r.pages).toEqual([]);
    expect(r.failures[0]).toMatch(/input/);
    expect(web.requests).toHaveLength(0);
  });

  it("normalizes bare domains to https", () => {
    expect(normalizeInputUrl(" smithtax.example/about ")).toBe("https://smithtax.example/about");
    expect(normalizeInputUrl("http://x.example")).toBe("http://x.example");
  });

  it("a page truncated at the 2 MB cap never counts toward the no-WISP points", async () => {
    const scoring = loadScoring();
    const toSearchable = (p: Awaited<ReturnType<typeof fetchSite>>["pages"][number]) => ({
      url: p.url,
      kind: p.kind,
      httpStatus: p.httpStatus,
      contentType: p.contentType,
      truncated: p.truncated,
      text: p.text,
      sha256: p.textSha256,
    });
    const run = async (maxBytes: number) => {
      const web = new FakeWeb()
        .host("tiny.example", [PUBLIC_IP])
        .route("https://tiny.example/", html("smithtax/index.html"))
        .route("https://tiny.example/privacy-policy", {
          status: 200,
          headers: { "content-type": "text/html" },
          body: "<html><body><main><p>" + "We respect client privacy and handle records with care. ".repeat(300) + "</p></main></body></html>",
        });
      const r = await fetchSite("tiny.example", deps(web, { maxBytes }).deps);
      const search = searchSecurityMentions(r.pages.map(toSearchable), scoring.wisp_keywords);
      const dossier = strongDossier({ pages_opened: r.pages.map((p) => p.url), security_mention_search: search }, scoring.wisp_keywords);
      const points = scoreDossier(dossier, scoring, new Date("2026-09-23T00:00:00Z")).breakdown.find((b) => b.key === "no_wisp_mention")!;
      return { r, points: points.points };
    };
    const complete = await run(2_000_000);
    expect(complete.r.pages.find((p) => p.kind === "privacy")!.truncated).toBe(false);
    expect(complete.points).toBe(10);
    const cut = await run(8_000); // homepage fits, the long privacy page is cut off
    expect(cut.r.pages.find((p) => p.kind === "home")!.truncated).toBe(false);
    expect(cut.r.pages.find((p) => p.kind === "privacy")!.truncated).toBe(true);
    expect(cut.r.failures.join()).toMatch(/truncated/);
    expect(cut.points).toBe(0);
  });

  it("feeds the WISP keyword search: smithtax has no mention, oakcpa does", async () => {
    const keywords = loadScoring().wisp_keywords;
    const toSearchable = (p: Awaited<ReturnType<typeof fetchSite>>["pages"][number]) => ({
      url: p.url,
      kind: p.kind,
      httpStatus: p.httpStatus,
      contentType: p.contentType,
      truncated: p.truncated,
      text: p.text,
      sha256: p.textSha256,
    });
    const smith = await fetchSite("smithtax.example", deps(sampleWeb()).deps);
    expect(searchSecurityMentions(smith.pages.map(toSearchable), keywords).matches).toEqual([]);
    const oak = await fetchSite("oakcpa.example", deps(sampleWeb()).deps);
    const hits = searchSecurityMentions(oak.pages.map(toSearchable), keywords).matches;
    expect(hits.map((h) => h.keyword)).toEqual(expect.arrayContaining(["wisp", "multi-factor"]));
    expect(new Set(hits.map((h) => h.url))).toEqual(new Set(["https://www.oakcpa.example/security"]));
  });
});
