import { NOT_FOUND, writerView, type ExtractedFacts, type Person } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadEvidence, loadScoring } from "../src/docs/loader";
import { cleanHtml, decodeCfEmail } from "../src/fetch/clean";
import { parseSitemap } from "../src/fetch/site";
import { contactPlan } from "../src/scoring/contact";
import { chooseDecisionMaker, computeGate, supportedSecondaryTypes, targetIndustryFit, usLocation } from "../src/scoring/derive";
import { computeFreshness } from "../src/scoring/freshness";
import { ev, HOME, strongDossier } from "./fixtures/dossiers";

const evidence = loadEvidence();
const scoring = loadScoring();
const keywords = evidence.firm_type_keywords;

const person = (name: string, title: string | null): Person => ({ name, title, evidence_url: HOME, evidence_quote: `${name}${title ? `, ${title}` : ""}` });
const services = (...items: string[]): ExtractedFacts["services"] => ({ value: items, evidence: items.map((item) => ({ item, evidence_url: HOME })) });

describe("decision maker by title preference (docs/06)", () => {
  it("uses the preference list order", () => {
    expect(evidence.decision_maker_title_preferences.slice(0, 4)).toEqual(["managing partner", "owner", "founder", "president"]);
    for (const t of ["ceo", "shareholder", "principal", "managing member", "partner"]) expect(evidence.decision_maker_title_preferences).toContain(t);
    expect(chooseDecisionMaker([person("Jim Bates", "President/Shareholder")], evidence.decision_maker_title_preferences)).toMatchObject({ value: { role_confirmed: true } });
    const dm = chooseDecisionMaker([person("Ann Lee", "Partner"), person("Bob Ray", "Office Manager"), person("Cy Oak", "Managing Partner")], evidence.decision_maker_title_preferences);
    expect(dm).toMatchObject({ value: { name: "Cy Oak", title: "Managing Partner" } });
  });

  it("ranks unmatched titles after matched ones, and missing titles last", () => {
    const prefs = evidence.decision_maker_title_preferences;
    expect(chooseDecisionMaker([person("A", null), person("B", "Senior Accountant")], prefs)).toMatchObject({ value: { name: "B" } });
    expect(chooseDecisionMaker([person("A", "Senior Accountant"), person("B", "Owner")], prefs)).toMatchObject({ value: { name: "B" } });
    expect(chooseDecisionMaker([], prefs)).toBe(NOT_FOUND);
  });
});

describe("firm type, secondary types, and target industry fit (code, never the model)", () => {
  it("keeps a secondary type only when the verified services show it", () => {
    const ft = ev({ primary: "credit_repair" as const, secondary: ["tax_preparer" as const, "payroll" as const] }, "credit repair");
    const r = supportedSecondaryTypes(ft, services("Credit repair", "Tax preparation"), keywords);
    expect(r.firmType).toMatchObject({ value: { secondary: ["tax_preparer"] } });
    expect(r.notes).toEqual(["firm_type: dropped secondary type payroll (not shown in the verified services)"]);
  });

  it("credit repair alone is not a target industry; with tax preparation services it qualifies", () => {
    const repairOnly = ev({ primary: "credit_repair" as const, secondary: [] }, "credit repair");
    expect(targetIndustryFit(repairOnly, services("Credit repair", "Score building"), scoring, keywords)).toMatchObject({ value: false });
    const withTax = ev({ primary: "credit_repair" as const, secondary: ["tax_preparer" as const] }, "credit repair");
    expect(targetIndustryFit(withTax, services("Credit repair", "Tax preparation"), scoring, keywords)).toMatchObject({ value: true, qualifying_type: "tax_preparer" });
    // Even without a reported secondary type, services with a target keyword qualify.
    expect(targetIndustryFit(repairOnly, services("Credit repair", "Income tax returns"), scoring, keywords)).toMatchObject({ value: true, qualifying_type: "tax_preparer" });
  });

  it("credit_repair is its own type, not in the target list", () => {
    expect(scoring.target_firm_types).not.toContain("credit_repair");
    expect(keywords.credit_repair).toContain("credit repair");
    expect(keywords.credit_counseling).not.toContain("credit repair");
  });

  it("fit is unknown (null) when neither firm type nor services were found", () => {
    expect(targetIndustryFit(NOT_FOUND, NOT_FOUND, scoring, keywords).value).toBeNull();
  });
});

describe("US location", () => {
  it("from country, or a US state when no country is given", () => {
    expect(usLocation(ev({ city: "Berea", state: "OH", country: "United States" }, "x")).value).toBe(true);
    expect(usLocation(ev({ city: "Berea", state: "OH", country: null }, "x")).value).toBe(true);
    expect(usLocation(ev({ city: "Toronto", state: "ON", country: "Canada" }, "x")).value).toBe(false);
    expect(usLocation(ev({ city: "Somewhere", state: null, country: null }, "x")).value).toBeNull();
    expect(usLocation(NOT_FOUND).value).toBeNull();
  });
});

describe("gates", () => {
  const fitTrue = { value: true, reason: "ok", qualifying_type: null };
  it("staff over max_staff_for_sequence (60) is out_of_icp", () => {
    expect(scoring.max_staff_for_sequence).toBe(60);
    const g = computeGate({ sizeSignal: ev({ staff_count: 150, text: "150+" }, "150+"), targetIndustryFit: fitTrue, exclusionSignals: [], scoring });
    expect(g).toEqual({ status: "out_of_icp", reasons: ["staff count 150 is above max_staff_for_sequence 60"] });
    expect(computeGate({ sizeSignal: ev({ staff_count: 60, text: "60" }, "60"), targetIndustryFit: fitTrue, exclusionSignals: [], scoring }).status).toBe("qualified");
  });

  it("target industry fit false is out_of_icp; unknown fit does not gate", () => {
    expect(computeGate({ sizeSignal: NOT_FOUND, targetIndustryFit: { value: false, reason: "no", qualifying_type: null }, exclusionSignals: [], scoring }).status).toBe("out_of_icp");
    expect(computeGate({ sizeSignal: NOT_FOUND, targetIndustryFit: { value: null, reason: "?", qualifying_type: null }, exclusionSignals: [], scoring }).status).toBe("qualified");
  });

  it("any exclusion signal is needs_review (out_of_icp wins when both apply)", () => {
    const signal = { signal: "government_or_nonprofit_only" as const, evidence_url: HOME, evidence_quote: "a government and nonprofit-only firm" };
    expect(computeGate({ sizeSignal: NOT_FOUND, targetIndustryFit: fitTrue, exclusionSignals: [signal], scoring }).status).toBe("needs_review");
    const both = computeGate({ sizeSignal: ev({ staff_count: 99, text: "99" }, "99"), targetIndustryFit: fitTrue, exclusionSignals: [signal], scoring });
    expect(both.status).toBe("out_of_icp");
    expect(both.reasons).toHaveLength(2);
  });
});

describe("contact matching and greeting", () => {
  it("greets the decision maker only when the address is theirs", () => {
    expect(contactPlan(strongDossier())).toMatchObject({ greeting: "Hi Jane,", contactMismatch: false });
    const other = strongDossier({ public_contact_email: ev({ address: "john.phillips@firm.example", owner_name: null }, "john.phillips@firm.example") });
    expect(contactPlan(other)).toMatchObject({ greeting: "Hi there,", contactMismatch: true });
    const tiedByQuote = strongDossier({ public_contact_email: ev({ address: "office@firm.example", owner_name: "Jane Smith" }, "Contact Jane Smith at office@firm.example") });
    expect(contactPlan(tiedByQuote)).toMatchObject({ greeting: "Hi Jane,", contactMismatch: false });
    for (const local of ["jsmith", "jane.smith", "janes", "smith"]) {
      const d = strongDossier({ public_contact_email: ev({ address: `${local}@firm.example`, owner_name: null }, `${local}@firm.example`) });
      expect(contactPlan(d).greetFirstName, local).toBe("Jane");
    }
  });

  it("neutral greeting without a decision maker, and no mismatch flag", () => {
    expect(contactPlan(strongDossier({ decision_maker: NOT_FOUND }))).toMatchObject({ greeting: "Hi there,", contactMismatch: false });
  });
});

describe("writer sees values only", () => {
  it("strips every evidence quote and URL", () => {
    const d = strongDossier({ firm_name: ev("RBV Financial", "I am the owner of RBV Financial, a Wife, and a mother to 2 boys.") });
    const view = JSON.stringify(writerView(d));
    expect(view).toContain("RBV Financial");
    expect(view).not.toContain("mother");
    expect(view).not.toContain("evidence_quote");
    expect(view).not.toContain("evidence_url");
    expect(view).not.toContain("Jane Smith, EA, Owner");
  });
});

describe("fetcher additions", () => {
  it("decodes Cloudflare-protected emails in text and links", () => {
    // "info@pb.example" XOR-encoded with key 0x42
    const encode = (s: string, key = 0x42) => key.toString(16).padStart(2, "0") + [...s].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
    const hex = encode("info@pb.example");
    expect(decodeCfEmail(hex)).toBe("info@pb.example");
    const html = `<html><body><main><p>Email <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a> or
      <a href="/cdn-cgi/l/email-protection#${encode("tax@pb.example")}">[email protected]</a>.</p></main></body></html>`;
    const page = cleanHtml(html, "https://pb.example/");
    expect(page.text).toContain("info@pb.example");
    expect(page.text).toContain("tax@pb.example");
    expect(page.text).not.toMatch(/email.?protected/i);
    expect(page.links.map((l) => l.href)).toContain("mailto:tax@pb.example");
  });

  it("reads machine-readable dates only (no copyright years, no founding dates)", () => {
    const html = `<html><head>
      <meta property="article:published_time" content="2026-03-04T10:00:00Z">
      <script type="application/ld+json">{"@graph":[{"@type":"Organization","foundingDate":"1998-01-01"},{"@type":"WebPage","datePublished":"2025-01-02","dateModified":"2026-05-06"}]}</script>
      </head><body><p>Posted <time datetime="2026-02-10">Feb 10</time>. Founded 1998. <time datetime="2026">2026</time></p><footer>© 2026 Firm</footer></body></html>`;
    const page = cleanHtml(html, "https://x.example/blog/post");
    expect(page.dates.map((d) => [d.date, d.source])).toEqual([
      ["2026-02-10", "time_element"],
      ["2026-03-04", "article_published_time"],
      ["2025-01-02", "jsonld_date_published"],
      ["2026-05-06", "jsonld_date_modified"],
    ]);
  });

  it("freshness: newest date wins; policy pages and future dates never count", () => {
    const now = new Date("2026-09-23T00:00:00Z");
    const pages = [
      { url: "https://x.example/", kind: "home" as const, dates: [{ date: "2025-01-02", source: "jsonld_date_published" as const, raw: "2025-01-02" }] },
      { url: "https://x.example/privacy-policy", kind: "privacy" as const, dates: [{ date: "2026-09-14", source: "time_element" as const, raw: "2026-09-14" }] },
    ];
    const sitemap = {
      url: "https://x.example/sitemap.xml",
      fromCache: false,
      entries: [
        { loc: "https://x.example/terms", lastmod: "2026-09-20" },
        { loc: "https://x.example/services", lastmod: "2026-04-01T00:00:00+00:00" },
        { loc: "https://x.example/future", lastmod: "2027-01-01" },
      ],
    };
    expect(computeFreshness(pages, sitemap, now)).toMatchObject({ value: { date: "2026-04-01", source: "sitemap_lastmod" }, evidence_url: "https://x.example/sitemap.xml" });
    expect(computeFreshness(pages, null, now)).toMatchObject({ value: { date: "2025-01-02", source: "jsonld_date_published" } });
    expect(computeFreshness([pages[1]!], null, now)).toBe(NOT_FOUND);
  });

  it("parses sitemap entries (urlset and sitemap index)", () => {
    const xml = `<?xml version="1.0"?><urlset><url><loc>https://x.example/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://x.example/b</loc></url></urlset>`;
    expect(parseSitemap(xml)).toEqual([{ loc: "https://x.example/a", lastmod: "2026-01-02" }]);
    const index = `<sitemapindex><sitemap><loc><![CDATA[https://x.example/post-sitemap.xml]]></loc><lastmod>2026-02-03</lastmod></sitemap></sitemapindex>`;
    expect(parseSitemap(index)).toEqual([{ loc: "https://x.example/post-sitemap.xml", lastmod: "2026-02-03" }]);
  });
});
