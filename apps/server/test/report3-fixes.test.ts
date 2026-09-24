import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadEvidence, loadScoring } from "../src/docs/loader";
import { verifyExtraction } from "../src/extract/verify";
import { cleanHtml, titleName } from "../src/fetch/clean";
import { classifyPage, loadSkipPatterns } from "../src/fetch/select";
import { fetchSite, userAgentFor, type SiteFetchDeps } from "../src/fetch/site";
import { chooseDecisionMaker } from "../src/scoring/derive";
import { classifyPublicEmail, contactPlan, isGenericInbox } from "../src/scoring/contact";
import { computeFreshness, urlPathDate } from "../src/scoring/freshness";
import { scoreDossier } from "../src/scoring/score";
import { ABOUT, ev, HOME, strongDossier } from "./fixtures/dossiers";
import { FakeWeb, fakeLimiter, PUBLIC_IP } from "./fixtures/fakeweb";

const evidence = loadEvidence();
const scoring = loadScoring();
const UA = userAgentFor("https://www.clearpathsecure.com/contact");
const NOW = new Date("2026-09-24T12:00:00.000Z");

const page = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const htmlRoute = (body: string) => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: Buffer.from(body) });
const textRoute = (body: string) => ({ status: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(body) });

function siteDeps(web: FakeWeb): SiteFetchDeps {
  return {
    resolver: web.resolver,
    transport: web.transport,
    userAgent: UA,
    timeoutMs: 1000,
    maxBytes: 2_000_000,
    skipPatterns: loadSkipPatterns(),
    limiter: fakeLimiter().limiter,
    now: () => NOW,
  };
}

describe("fix 1: firm-name candidates from markup; quotes may match the page title", () => {
  it("reads JSON-LD Organization name, og:site_name, and the title before its separator", () => {
    const head =
      '<title>Maple Street CPAs | Tax &amp; Accounting in Dayton</title><meta property="og:site_name" content="Maple Street CPAs">' +
      '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite","name":"Site"},{"@type":["AccountingService"],"name":"Maple Street CPAs, LLC"}]}</script>';
    const c = cleanHtml(page("<p>Welcome.</p>", head), "https://maple.example/");
    expect(c.nameHints).toEqual([
      { source: "jsonld_organization", value: "Maple Street CPAs, LLC" },
      { source: "og_site_name", value: "Maple Street CPAs" },
      { source: "title", value: "Maple Street CPAs" },
    ]);
  });

  it("skips a generic first title part ('Home | Firm')", () => {
    expect(titleName("Home | Oak Tax Group")).toBe("Oak Tax Group");
    expect(titleName("Oak Tax Group - Dayton, OH")).toBe("Oak Tax Group");
    expect(titleName("Home")).toBeNull();
  });

  it("verifies a firm_name quote copied from the page title", () => {
    const pages = new Map([[HOME, { text: "We prepare returns for families and businesses.", title: "Oak Tax Group | Dayton" }]]);
    const v = verifyExtraction({ firm_name: ev("Oak Tax Group", "Oak Tax Group | Dayton") }, { pages, evidence });
    expect(v.checks.firm_name.status).toBe("verified");
    // Other fields still need body text.
    const w = verifyExtraction({ location: ev({ city: "Dayton", state: "OH", country: "US" }, "Oak Tax Group | Dayton") }, { pages, evidence });
    expect(w.checks.location).toMatchObject({ status: "rejected", kind: "quote_not_found" });
  });
});

describe("fix 3: HTTP 403/429 means declined_automated_access", () => {
  function web(homeStatus: number | null, aboutStatus = 200, robotsStatus = 200) {
    const w = new FakeWeb().host("blocked.example", [PUBLIC_IP]);
    w.route("https://blocked.example/robots.txt", robotsStatus === 200 ? textRoute("User-agent: *\nAllow: /\n") : { status: robotsStatus, headers: {} });
    w.route(
      "https://blocked.example/",
      homeStatus === null
        ? htmlRoute(page('<a href="/about">About</a><a href="/services">Services</a><a href="/contact">Contact</a><p>' + "Tax help. ".repeat(40) + "</p>"))
        : { status: homeStatus, headers: {} },
    );
    w.route("https://blocked.example/about", aboutStatus === 200 ? htmlRoute(page("<p>About us.</p>")) : { status: aboutStatus, headers: {} });
    w.route("https://blocked.example/services", htmlRoute(page("<p>Services.</p>")));
    w.route("https://blocked.example/contact", htmlRoute(page("<p>Contact.</p>")));
    return w;
  }

  for (const status of [403, 429]) {
    it(`homepage ${status}: records it, makes no further requests, never retries`, async () => {
      const w = web(status);
      const r = await fetchSite("blocked.example", siteDeps(w));
      expect(r.declined).toEqual({ url: "https://blocked.example/", status });
      expect(w.requests.map((q) => q.url)).toEqual(["https://blocked.example/robots.txt", "https://blocked.example/"]);
      expect(r.failures.join("\n")).toMatch(new RegExp(`declined_automated_access: https://blocked.example/ answered HTTP ${status}.*Paste the site text`));
      for (const q of w.requests) expect(q.headers["user-agent"]).toBe(UA);
    });
  }

  it("a subpage 403 stops the crawl but keeps the pages already fetched", async () => {
    const w = web(null, 403);
    const r = await fetchSite("blocked.example", siteDeps(w));
    expect(r.declined).toMatchObject({ status: 403 });
    expect(r.pages.map((p) => p.kind)).toEqual(["home"]);
    const urls = w.requests.map((q) => q.url);
    expect(urls).not.toContain("https://blocked.example/services");
    expect(urls.some((u) => u.includes("sitemap"))).toBe(false);
  });

  it("robots.txt 403: the homepage is never requested", async () => {
    const w = web(null, 200, 403);
    const r = await fetchSite("blocked.example", siteDeps(w));
    expect(r.declined).toMatchObject({ status: 403 });
    expect(w.requests.map((q) => q.url)).toEqual(["https://blocked.example/robots.txt"]);
    expect(r.pages).toEqual([]);
  });

  it("a declined lead with too few pages gets no no-WISP points", () => {
    const d = strongDossier({ declined_automated_access: true });
    const search = d.security_mention_search;
    if (search === "NOT_CHECKED") throw new Error("fixture");
    const onlyHome = { ...search, pages: search.pages.filter((p) => p.kind === "home") };
    const s = scoreDossier({ ...d, security_mention_search: onlyHome }, scoring, NOW);
    expect(s.breakdown.find((b) => b.key === "no_wisp_mention")!.points).toBe(0);
  });
});

describe("fix 4: url_date freshness and one dated post as the news page", () => {
  const skip = loadSkipPatterns();
  const skipped = (path: string) => skip.some((re) => re.test(path));

  it("classifies a dated post as news; date archives stay skipped", () => {
    expect(classifyPage(new URL("https://a.example/2025/11/14/year-end-planning/"))).toBe("news");
    expect(classifyPage(new URL("https://a.example/2025/11/year-end-planning"))).toBe("news");
    expect(skipped("/2025/11/14/year-end-planning/")).toBe(false);
    for (const p of ["/2025/", "/2025/11/", "/2025/11/14/", "/tag/tax/", "/category/news/"]) expect(skipped(p), p).toBe(true);
  });

  it("parses /YYYY/MM/DD/ from URL paths", () => {
    expect(urlPathDate("https://a.example/2026/03/14/new-hire/")).toBe("2026-03-14");
    expect(urlPathDate("https://a.example/2026/13/14/x")).toBeNull();
    expect(urlPathDate("https://a.example/services/")).toBeNull();
  });

  it("uses url_date only when no machine-readable date exists", () => {
    const post = { url: "https://a.example/2026/03/14/new-hire/", kind: "news" as const, dates: [] };
    expect(computeFreshness([post], null, NOW)).toMatchObject({ value: { date: "2026-03-14", source: "url_date" }, evidence_url: post.url });
    const marked = { url: "https://a.example/", kind: "home" as const, dates: [{ date: "2025-01-02", source: "time_element" as const, raw: "2025-01-02" }] };
    expect(computeFreshness([post, marked], null, NOW)).toMatchObject({ value: { source: "time_element" } });
  });
});

describe("fix 5: generic inboxes", () => {
  const prefixes = evidence.generic_inbox_prefixes;
  const email = (address: string, owner_name: string | null = null) => ev({ address, owner_name }, address);
  const jane = [{ name: "Jane Smith", title: "Owner", evidence_url: ABOUT, evidence_quote: "Jane Smith, Owner" }];

  it("detects role inboxes from the editable list", () => {
    for (const a of ["info@x.com", "Office@x.com", "contact@x.com", "hello@x.com", "marketing@x.com", "admin@x.com", "info2@x.com", "info.dayton@x.com"]) {
      expect(isGenericInbox(a, prefixes), a).toBe(true);
    }
    for (const a of ["jane@x.com", "information-desk@x.com", "jsmith@x.com"]) expect(isGenericInbox(a, prefixes), a).toBe(false);
  });

  it("classifies the public address: generic wins over an owner name", () => {
    expect(classifyPublicEmail(email("info@smithtax.example", "Jane Smith"), jane, prefixes)).toBe("generic_inbox");
    expect(classifyPublicEmail(email("jsmith@smithtax.example"), jane, prefixes)).toBe("named_person");
    expect(classifyPublicEmail(email("returns@smithtax.example", "Jane Smith"), jane, prefixes)).toBe("named_person");
    expect(classifyPublicEmail(email("returns@smithtax.example"), jane, prefixes)).toBe("unattributed");
    expect(classifyPublicEmail(NOT_FOUND, jane, prefixes)).toBe(NOT_FOUND);
  });

  it("scores 10 for a named person's address, 5 for a generic or unattributed one", () => {
    const pts = (d: Dossier) => scoreDossier(d, scoring, NOW).breakdown.find((b) => b.key === "public_business_email")!;
    expect(pts(strongDossier()).points).toBe(10);
    const generic = strongDossier({ public_contact_email: email("info@smithtax.example"), public_email_kind: "generic_inbox" });
    expect(pts(generic)).toMatchObject({ points: 5, reason: expect.stringContaining("generic_inbox") });
    expect(pts(strongDossier({ public_email_kind: "unattributed" })).points).toBe(5);
  });

  it("never greets a generic inbox by name", () => {
    const d = strongDossier({ public_contact_email: email("jane@smithtax.example", "Jane Smith"), public_email_kind: "generic_inbox" });
    expect(contactPlan(d)).toMatchObject({ greeting: null, greetFirstName: null, genericInbox: true });
    expect(contactPlan(strongDossier())).toMatchObject({ greeting: "Hi Jane,", genericInbox: false });
  });
});

describe("fix 6: decision maker role confirmation", () => {
  const person = (name: string, title: string | null) => ({ name, title, evidence_url: ABOUT, evidence_quote: `${name}${title ? `, ${title}` : ""}` });
  const prefs = evidence.decision_maker_title_preferences;

  it("role_confirmed only when the title is on the preference list", () => {
    expect(chooseDecisionMaker([person("Ann Lee", "Managing Partner")], prefs)).toMatchObject({ value: { role_confirmed: true } });
    expect(chooseDecisionMaker([person("Ann Lee", "Senior Tax Associate")], prefs)).toMatchObject({ value: { role_confirmed: false } });
    expect(chooseDecisionMaker([person("Ann Lee", null)], prefs)).toMatchObject({ value: { role_confirmed: false } });
  });

  it("scores 10 for a confirmed role, 5 with a role_unconfirmed reason otherwise", () => {
    const pts = (d: Dossier) => scoreDossier(d, scoring, NOW).breakdown.find((b) => b.key === "decision_maker_named")!;
    expect(pts(strongDossier()).points).toBe(10);
    const unconfirmed = strongDossier({ decision_maker: ev({ name: "Jane Smith", title: "Tax Associate", role_confirmed: false }, "Jane Smith, Tax Associate", ABOUT) });
    expect(pts(unconfirmed)).toMatchObject({ points: 5, reason: expect.stringMatching(/^role_unconfirmed/) });
  });
});

describe("fix 7: security_or_wisp_mention definition", () => {
  it("the tool schema tells the model that services sold to clients do not count", async () => {
    const { extractionToolSchema } = await import("@clearpath/shared");
    const props = extractionToolSchema().properties as Record<string, { description?: string }>;
    expect(props.security_or_wisp_mention!.description).toMatch(/OWN security practices/);
    expect(props.security_or_wisp_mention!.description).toMatch(/do not count/);
    expect(props.recent_signal).toBeUndefined();
  });
});

describe("fix 8 support: over-long verbatim quotes are cut by code, not retried", () => {
  const text = "Inner Circle Advisors is a leading-edge, cloud-based, business advisory services firm led by an experienced CPA and team.";
  const pages = new Map([[HOME, { text, title: "" }]]);
  const long = "Inner Circle Advisors is a leading-edge, cloud-based, business advisory services firm led by an experienced CPA";

  it("cuts a 16-word firm_type quote to the first 15-word window holding a type keyword", () => {
    const v = verifyExtraction({ firm_type: ev({ primary: "cpa", secondary: [] }, long) }, { pages, evidence });
    expect(v.checks.firm_type.status).toBe("verified");
    expect(v.facts.firm_type).toMatchObject({ evidence_quote: "Circle Advisors is a leading-edge, cloud-based, business advisory services firm led by an experienced CPA" });
    expect(v.checks.firm_type.notes).toEqual(["firm_type: quote cut by code from 16 to 15 words around the value"]);
  });

  it("does not cut a quote that is not verbatim, or one with no window holding the value", () => {
    const stitched = verifyExtraction({ firm_type: ev({ primary: "cpa", secondary: [] }, `${long} extra words here`) }, { pages, evidence });
    expect(stitched.checks.firm_type).toMatchObject({ status: "rejected", kind: "quote_too_long" });
    const noKeyword = verifyExtraction({ firm_type: ev({ primary: "tax_preparer", secondary: [] }, long) }, { pages, evidence });
    expect(noKeyword.checks.firm_type).toMatchObject({ status: "rejected", kind: "quote_too_long" });
  });

  it("firm-type keywords match plurals ('audit' matches 'audits')", async () => {
    const { typesShownInServices } = await import("../src/scoring/derive");
    const services = { value: ["audits", "consulting services"], evidence: [{ item: "audits", evidence_url: HOME }, { item: "consulting services", evidence_url: HOME }] };
    expect(typesShownInServices(services, evidence.firm_type_keywords)).toContain("cpa");
  });

  it("prefers the title part another hint confirms over a slogan", () => {
    const head = '<title>A Business Advisor You Can Trust | Inner Circle Advisors</title><meta property="og:site_name" content="Inner Circle Advisors">';
    expect(cleanHtml(page("<p>x</p>", head), "https://ic.example/").nameHints).toEqual([
      { source: "og_site_name", value: "Inner Circle Advisors" },
      { source: "title", value: "Inner Circle Advisors" },
    ]);
  });
});
