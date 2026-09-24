import { NOT_FOUND, type ScoringConfig } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadScoring } from "../src/docs/loader";
import { partialDateEnd, scoreDossier, tierFor } from "../src/scoring/score";
import { searchSecurityMentions } from "../src/scoring/security-search";
import { ABOUT, cleanSearch, dnsEv, emptyDossier, ev, HOME, PRIVACY, strongDossier } from "./fixtures/dossiers";

const config = loadScoring();
const AS_OF = new Date("2026-09-23T00:00:00.000Z");
const strong = (o: Parameters<typeof strongDossier>[0] = {}) => strongDossier(o, config.wisp_keywords);

function points(key: string, d = strong(), c: ScoringConfig = config, asOf = AS_OF) {
  return scoreDossier(d, c, asOf).breakdown.find((b) => b.key === key)!.points;
}

describe("scoreDossier (docs/06)", () => {
  it("scores the strong fixture 100: every signal present and evidenced", () => {
    const r = scoreDossier(strong(), config, AS_OF);
    expect(r.breakdown.filter((b) => b.points === 0).map((b) => b.key)).toEqual([]);
    expect(r.total).toBe(100);
    expect(r.tier).toBe("A");
    expect(r.fitPoints).toBe(40);
  });

  it("scores an all-NOT_FOUND dossier 0 (NOT_FOUND is never a negative finding)", () => {
    const r = scoreDossier(emptyDossier(), config, AS_OF);
    expect(r.total).toBe(0);
    expect(r.tier).toBe("C");
  });

  it("is deterministic and pure", () => {
    const d = strong();
    const snapshot = JSON.stringify(d);
    expect(scoreDossier(d, config, AS_OF)).toEqual(scoreDossier(d, config, AS_OF));
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("uses the weights from the config, not constants", () => {
    const heavier = structuredClone(config);
    heavier.criteria.find((c) => c.key === "firm_type_in_target")!.points = 25;
    heavier.criteria.find((c) => c.key === "public_business_email")!.points = 0;
    expect(points("firm_type_in_target", strong(), heavier)).toBe(25);
    expect(points("public_business_email", strong(), heavier)).toBe(0);
  });

  describe("fit", () => {
    it("firm type: a target primary type scores; 'other' and credit_repair do not", () => {
      expect(points("firm_type_in_target")).toBe(10);
      expect(points("firm_type_in_target", strong({ firm_type: ev({ primary: "other" as const, secondary: [] }, "x") }))).toBe(0);
      expect(points("firm_type_in_target", strong({ firm_type: ev({ primary: "credit_repair" as const, secondary: [] }, "x") }))).toBe(0);
    });

    it("firm type: a supported secondary target type qualifies a credit repair firm", () => {
      const d = strong({ firm_type: ev({ primary: "credit_repair" as const, secondary: ["tax_preparer" as const] }, "credit repair") });
      expect(points("firm_type_in_target", d)).toBe(10);
    });

    it("us_location and target_industry_fit are separate criteria read from code-computed fields", () => {
      expect(points("us_location")).toBe(5);
      expect(points("target_industry_fit")).toBe(5);
      expect(points("us_location", strong({ us_location: { value: false, reason: "country Canada is not the US", qualifying_type: null } }))).toBe(0);
      expect(points("us_location", strong({ us_location: { value: null, reason: "unknown", qualifying_type: null } }))).toBe(0);
      expect(points("target_industry_fit", strong({ target_industry_fit: { value: null, reason: "unknown", qualifying_type: null } }))).toBe(0);
    });

    it("size: scores only a stated staff count within 3-30; no size signal scores 0", () => {
      const size = (n: number | null) => strong({ size_signal: ev({ staff_count: n, text: "t" }, "t") });
      expect(points("size_in_range", size(3))).toBe(10);
      expect(points("size_in_range", size(30))).toBe(10);
      expect(points("size_in_range", size(2))).toBe(0);
      expect(points("size_in_range", size(31))).toBe(0);
      expect(points("size_in_range", size(null))).toBe(0);
      expect(points("size_in_range", strong({ size_signal: NOT_FOUND }))).toBe(0);
    });

    it("decision maker named (code-chosen)", () => {
      expect(points("decision_maker_named")).toBe(10);
      expect(points("decision_maker_named", strong({ decision_maker: NOT_FOUND }))).toBe(0);
    });
  });

  describe("gates and fit first", () => {
    it("an out_of_icp lead gets no signal points, only fit and reachability", () => {
      const d = strong({ gate: { status: "out_of_icp", reasons: ["staff count 150 is above max_staff_for_sequence 60"] } });
      const r = scoreDossier(d, config, AS_OF);
      for (const b of r.breakdown.filter((x) => x.group === "signals")) {
        expect(b.points, b.key).toBe(0);
        expect(b.reason).toMatch(/out_of_icp/);
      }
      expect(r.total).toBe(60);
    });

    it("needs_review does not remove signal points (the founder decides)", () => {
      const d = strong({ gate: { status: "needs_review", reasons: ["exclusion signal government_or_nonprofit_only"] } });
      expect(scoreDossier(d, config, AS_OF).total).toBe(100);
    });

    it("caps the tier at C when fit points are below fit_threshold", () => {
      const weakFit = strong({
        firm_type: ev({ primary: "other" as const, secondary: [] }, "x"),
        target_industry_fit: { value: null, reason: "unknown", qualifying_type: null },
        size_signal: NOT_FOUND,
        decision_maker: NOT_FOUND,
      });
      const r = scoreDossier(weakFit, config, AS_OF);
      expect(r.fitPoints).toBe(5);
      expect(r.fitPoints).toBeLessThan(config.fit_threshold);
      expect(tierFor(r.total, config)).not.toBe("C");
      expect(r.tier).toBe("C");
      expect(r.tierCapped).toBe(true);
    });
  });

  describe("signals", () => {
    describe("no WISP/security mention (evidenced by the recorded keyword search)", () => {
      type Search = ReturnType<typeof cleanSearch>;
      const withSearch = (edit: (s: Search) => void, over: Parameters<typeof strongDossier>[0] = {}) => {
        const search = cleanSearch(config.wisp_keywords);
        edit(search);
        return strong({ security_mention_search: search, ...over });
      };

      it("scores with home + privacy searched completely and nothing matched", () => {
        expect(points("no_wisp_mention")).toBe(10);
      });

      it("does not score without a recorded search, or when the model found a mention", () => {
        expect(points("no_wisp_mention", strong({ security_mention_search: "NOT_CHECKED" }))).toBe(0);
        expect(points("no_wisp_mention", strong({ security_or_wisp_mention: ev("We maintain a WISP", "WISP") }))).toBe(0);
      });

      it("does not score when any keyword matched", () => {
        const matched = withSearch((s) => {
          (s.matches as { url: string; keyword: string }[]).push({ url: HOME, keyword: "encryption" });
        });
        expect(points("no_wisp_mention", matched)).toBe(0);
      });

      it("needs a privacy or security page, or at least wisp_min_pages (3) complete pages", () => {
        expect(config.wisp_min_pages).toBe(3);
        // home + about only: 2 pages, no policy page -> 0
        const twoPages = withSearch((s) => (s.pages = s.pages.filter((p) => p.url !== PRIVACY)));
        expect(points("no_wisp_mention", twoPages)).toBe(0);
        // home + privacy: policy page present -> 10
        const homePrivacy = withSearch((s) => (s.pages = s.pages.filter((p) => p.url !== ABOUT)));
        expect(points("no_wisp_mention", homePrivacy)).toBe(10);
        // home + about + another page, no policy page: 3 pages -> 10
        const extra = "https://smithtax.example/services";
        const threePages = withSearch(
          (s) => {
            s.pages = s.pages.filter((p) => p.url !== PRIVACY);
            s.pages.push({ ...s.pages[0]!, url: extra, kind: "services" as never });
          },
          { pages_opened: [HOME, ABOUT, PRIVACY, extra] },
        );
        expect(points("no_wisp_mention", threePages)).toBe(10);
      });

      it("requires the homepage", () => {
        expect(points("no_wisp_mention", withSearch((s) => (s.pages = s.pages.filter((p) => p.kind !== "home"))))).toBe(0);
      });

      it("ignores truncated, near-empty, non-200, and non-HTML pages", () => {
        const breakPrivacy = (patch: object) =>
          withSearch((s) => {
            s.pages = s.pages.filter((p) => p.url !== ABOUT).map((p) => (p.kind === "home" ? p : { ...p, ...patch }));
          });
        expect(points("no_wisp_mention", breakPrivacy({ truncated: true }))).toBe(0);
        expect(points("no_wisp_mention", breakPrivacy({ text_chars: 50 }))).toBe(0);
        expect(points("no_wisp_mention", breakPrivacy({ http_status: 404 }))).toBe(0);
        expect(points("no_wisp_mention", breakPrivacy({ content_type: "application/pdf" }))).toBe(0);
      });

      it("does not score if the docs/06 keyword list gained keywords since the search", () => {
        expect(points("no_wisp_mention", strongDossier({}, config.wisp_keywords.slice(1)))).toBe(0);
      });

      it("'secure portal' is not a WISP keyword any more", () => {
        expect(config.wisp_keywords).not.toContain("secure portal");
      });
    });

    it("searchSecurityMentions records every page with its hash and each keyword hit", () => {
      const page = (url: string, text: string) => ({ url, kind: "home" as const, httpStatus: 200, contentType: "text/html", truncated: false, text, sha256: "b".repeat(64) });
      const r = searchSecurityMentions([page(HOME, "Documents are Encrypted at rest."), page(ABOUT, "Family owned since 1990.")], ["encrypted", "wisp"]);
      expect(r.matches).toEqual([{ url: HOME, keyword: "encrypted" }]);
      expect(r.pages.map((p) => p.url)).toEqual([HOME, ABOUT]);
      expect(searchSecurityMentions([page(HOME, "wispy clouds")], ["wisp"]).matches).toEqual([]);
    });

    describe("DMARC (only when the domain has email)", () => {
      const withDns = (noEmail: unknown, present: unknown, policy: unknown) => {
        const d = strong();
        d.dns.no_domain_email = noEmail as never;
        d.dns.dmarc_present = present as never;
        d.dns.dmarc_policy = policy as never;
        return d;
      };
      const hasMx = dnsEv(false, "smithtax.example", "MX");

      it("missing record or policy=none scores when MX exists", () => {
        expect(points("dmarc_missing_or_none", withDns(hasMx, dnsEv(false), NOT_FOUND))).toBe(10);
        expect(points("dmarc_missing_or_none", withDns(hasMx, dnsEv(true), dnsEv("none")))).toBe(10);
        expect(points("dmarc_missing_or_none", withDns(hasMx, dnsEv(true), dnsEv("reject")))).toBe(0);
      });

      it("a domain with no MX records (no_domain_email) never earns DMARC points", () => {
        expect(points("dmarc_missing_or_none", withDns(dnsEv(true, "x", "MX"), dnsEv(false), NOT_FOUND))).toBe(0);
      });

      it("lookup failures are never scored", () => {
        expect(points("dmarc_missing_or_none", withDns(NOT_FOUND, dnsEv(false), NOT_FOUND))).toBe(0);
        expect(points("dmarc_missing_or_none", withDns(hasMx, NOT_FOUND, NOT_FOUND))).toBe(0);
      });
    });

    it("personal email domain: providers on the docs/06 list, including their subdomains", () => {
      const addr = (a: string) => strong({ personal_email_domain_on_site: ev(a, "x") });
      expect(points("personal_email_domain")).toBe(5);
      expect(points("personal_email_domain", addr("jane@smithtax.example"))).toBe(0);
      expect(points("personal_email_domain", addr("smithtax@columbus.rr.com"))).toBe(5);
      expect(points("personal_email_domain", addr("office@wowway.com"))).toBe(5);
      expect(points("personal_email_domain", addr("x@notgmail.com"))).toBe(0);
    });

    it("sensitive data: keyword match on services, not inside other words", () => {
      const svc = (...s: string[]) => strong({ services: { value: s, evidence: s.map((item) => ({ item, evidence_url: HOME })) } });
      expect(points("sensitive_data_services", svc("Payroll processing"))).toBe(10);
      expect(points("sensitive_data_services", svc("Credit counseling"))).toBe(10);
      expect(points("sensitive_data_services", svc("Syntax consulting", "Web design"))).toBe(0);
    });

    it("doc exchange without a secure portal: the portal's absence comes from the code's keyword search", () => {
      const f = (secure_portal: true | null) => strong({ client_portal_or_doc_exchange: ev({ doc_exchange: true as const, secure_portal }, "x") });
      expect(points("doc_exchange_without_portal", f(null))).toBe(5);
      expect(points("doc_exchange_without_portal", f(true))).toBe(0);
      const search = strong().portal_mention_search;
      if (search === "NOT_CHECKED") throw new Error("fixture");
      const withMatch = strong({ portal_mention_search: { ...search, matches: [{ url: HOME, keyword: "portal" }] } });
      expect(points("doc_exchange_without_portal", withMatch)).toBe(0);
      expect(points("doc_exchange_without_portal", strong({ portal_mention_search: "NOT_CHECKED" }))).toBe(0);
    });
  });

  describe("reachability", () => {
    it("public business email and phone/contact form", () => {
      expect(points("public_business_email")).toBe(10);
      expect(points("phone_or_contact_form")).toBe(5);
      expect(points("phone_or_contact_form", strong({ phone_or_contact_form: ev({ phone: null, contact_form: true as const }, "x") }))).toBe(5);
      expect(points("phone_or_contact_form", strong({ phone_or_contact_form: "NOT_FOUND" }))).toBe(0);
    });

    it("site maintained: code-computed date within 12 months; recent_signal no longer counts", () => {
      const dated = (date: string) => strong({ latest_dated_content: { value: { date, source: "sitemap_lastmod" }, evidence_url: HOME, evidence_quote: date } });
      expect(points("site_maintained", dated("2025-09-24"))).toBe(5);
      expect(points("site_maintained", dated("2025-09-22"))).toBe(0);
      expect(points("site_maintained", dated("2025-09"))).toBe(5);
      expect(points("site_maintained", strong({ latest_dated_content: NOT_FOUND }))).toBe(0);
    });
  });

  it("tier cutoffs come from docs/06: A >= 70, B 50-69, C < 50", () => {
    expect(tierFor(70, config)).toBe("A");
    expect(tierFor(69, config)).toBe("B");
    expect(tierFor(50, config)).toBe("B");
    expect(tierFor(49, config)).toBe("C");
  });

  it("partialDateEnd resolves to the last moment of the stated period", () => {
    expect(partialDateEnd("2024-02").toISOString()).toBe("2024-02-29T23:59:59.999Z");
    expect(partialDateEnd("2025-03-05").toISOString()).toBe("2025-03-05T23:59:59.999Z");
  });
});
