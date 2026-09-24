import { NOT_FOUND, type ScoringConfig } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadScoring } from "../src/docs/loader";
import { partialDateEnd, scoreDossier, tierFor } from "../src/scoring/score";
import { searchSecurityMentions } from "../src/scoring/security-search";
import { ABOUT, cleanSearch, dnsEv, emptyDossier, ev, HOME, strongDossier } from "./fixtures/dossiers";

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
    it("firm type: target types score, 'other' does not", () => {
      expect(points("firm_type_in_target")).toBe(15);
      expect(points("firm_type_in_target", strong({ firm_type: ev("other" as const, "x") }))).toBe(0);
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

    it("US and in scope: only an evidenced true", () => {
      expect(points("us_in_scope")).toBe(5);
      expect(points("us_in_scope", strong({ in_scope: ev(false, "x") }))).toBe(0);
    });

    it("decision maker named", () => {
      expect(points("decision_maker_named")).toBe(10);
      expect(points("decision_maker_named", strong({ decision_maker: NOT_FOUND }))).toBe(0);
    });
  });

  describe("signals", () => {
    describe("no WISP/security mention (evidenced by the recorded keyword search)", () => {
      type Search = ReturnType<typeof cleanSearch>;
      const withSearch = (edit: (s: Search) => void) => {
        const search = cleanSearch(config.wisp_keywords);
        edit(search);
        return strong({ security_mention_search: search });
      };

      it("scores when home + about/privacy were searched completely and nothing matched", () => {
        expect(points("no_wisp_mention")).toBe(10);
        const r = scoreDossier(strong(), config, AS_OF).breakdown.find((b) => b.key === "no_wisp_mention")!;
        expect(r.fields).toEqual(["security_mention_search"]);
      });

      it("does not score without a recorded search (NOT_CHECKED)", () => {
        expect(points("no_wisp_mention", strong({ security_mention_search: "NOT_CHECKED" }))).toBe(0);
      });

      it("does not score when the LLM found a security mention", () => {
        expect(points("no_wisp_mention", strong({ security_or_wisp_mention: ev("We maintain a WISP", "WISP") }))).toBe(0);
      });

      it("does not score when any keyword matched", () => {
        const matched = withSearch((s) => {
          (s.matches as { url: string; keyword: string }[]).push({ url: HOME, keyword: "encryption" });
        });
        expect(points("no_wisp_mention", matched)).toBe(0);
      });

      it("requires the homepage", () => {
        expect(points("no_wisp_mention", withSearch((s) => (s.pages = s.pages.filter((p) => p.kind !== "home"))))).toBe(0);
      });

      it("requires at least one privacy, security, or about page", () => {
        expect(points("no_wisp_mention", withSearch((s) => (s.pages = s.pages.filter((p) => p.kind === "home"))))).toBe(0);
        const privacyOnly = withSearch((s) => (s.pages = s.pages.filter((p) => p.url !== ABOUT)));
        expect(points("no_wisp_mention", privacyOnly)).toBe(10);
      });

      it("ignores truncated, near-empty, non-200, and non-HTML pages", () => {
        const breakSupporting = (patch: object) =>
          withSearch((s) => {
            s.pages = s.pages.map((p) => (p.kind === "home" ? p : { ...p, ...patch }));
          });
        expect(points("no_wisp_mention", breakSupporting({ truncated: true }))).toBe(0);
        expect(points("no_wisp_mention", breakSupporting({ text_chars: 50 }))).toBe(0);
        expect(points("no_wisp_mention", breakSupporting({ http_status: 404 }))).toBe(0);
        expect(points("no_wisp_mention", breakSupporting({ content_type: "application/pdf" }))).toBe(0);
      });

      it("ignores a searched page that is not in pages_opened", () => {
        expect(points("no_wisp_mention", strong({ pages_opened: [HOME] }))).toBe(0);
      });

      it("does not score if the docs/06 keyword list gained keywords since the search", () => {
        expect(points("no_wisp_mention", strongDossier({}, config.wisp_keywords.slice(1)))).toBe(0);
      });
    });

    it("searchSecurityMentions records every page with its hash and each keyword hit", () => {
      const page = (url: string, text: string) => ({
        url,
        kind: "home" as const,
        httpStatus: 200,
        contentType: "text/html",
        truncated: false,
        text,
        sha256: "b".repeat(64),
      });
      const r = searchSecurityMentions(
        [page(HOME, "We file taxes. Documents are Encrypted at rest."), page(ABOUT, "Family owned since 1990.")],
        ["encrypted", "wisp"],
      );
      expect(r.matches).toEqual([{ url: HOME, keyword: "encrypted" }]);
      expect(r.pages.map((p) => [p.url, p.sha256, p.text_chars])).toEqual([
        [HOME, "b".repeat(64), 47],
        [ABOUT, "b".repeat(64), 24],
      ]);
      expect(searchSecurityMentions([page(HOME, "wispy clouds")], ["wisp"]).matches).toEqual([]);
    });

    it("DMARC: missing record or policy=none scores; enforcing policy or NOT_FOUND does not", () => {
      const withDns = (present: unknown, policy: unknown) => {
        const d = strong();
        d.dns.dmarc_present = present as never;
        d.dns.dmarc_policy = policy as never;
        return d;
      };
      expect(points("dmarc_missing_or_none", withDns(dnsEv(false), NOT_FOUND))).toBe(10);
      expect(points("dmarc_missing_or_none", withDns(dnsEv(true), dnsEv("none")))).toBe(10);
      expect(points("dmarc_missing_or_none", withDns(dnsEv(true), dnsEv("reject")))).toBe(0);
      expect(points("dmarc_missing_or_none", withDns(dnsEv(true), dnsEv("quarantine")))).toBe(0);
      expect(points("dmarc_missing_or_none", withDns(NOT_FOUND, NOT_FOUND))).toBe(0);
    });

    it("personal email domain: providers on the docs/06 list, including their subdomains", () => {
      const addr = (a: string) => strong({ personal_email_domain_on_site: ev(a, "x") });
      expect(points("personal_email_domain")).toBe(5);
      expect(points("personal_email_domain", addr("jane@smithtax.example"))).toBe(0);
      expect(points("personal_email_domain", addr("Jane@Yahoo.com"))).toBe(5);
      expect(points("personal_email_domain", addr("smithtax@columbus.rr.com"))).toBe(5);
      expect(points("personal_email_domain", addr("office@roadrunner.com"))).toBe(5);
      expect(points("personal_email_domain", addr("office@wowway.com"))).toBe(5);
      expect(points("personal_email_domain", addr("x@notgmail.com"))).toBe(0);
    });

    it("sensitive data: keyword match on services, not inside other words", () => {
      const svc = (...s: string[]) => strong({ services: ev(s, "x") });
      expect(points("sensitive_data_services", svc("Payroll processing"))).toBe(10);
      expect(points("sensitive_data_services", svc("Credit counseling"))).toBe(10);
      expect(points("sensitive_data_services", svc("Debt management plans"))).toBe(10);
      expect(points("sensitive_data_services", svc("Syntax consulting", "Web design"))).toBe(0);
    });

    it("doc exchange without a secure portal", () => {
      const f = (doc_exchange: boolean, secure_portal: boolean) =>
        strong({ client_portal_or_doc_exchange: ev({ doc_exchange, secure_portal }, "x") });
      expect(points("doc_exchange_without_portal", f(true, false))).toBe(5);
      expect(points("doc_exchange_without_portal", f(true, true))).toBe(0);
      expect(points("doc_exchange_without_portal", f(false, false))).toBe(0);
    });
  });

  describe("reachability", () => {
    it("public business email and phone/contact form", () => {
      expect(points("public_business_email")).toBe(10);
      expect(points("phone_or_contact_form")).toBe(5);
      const formOnly = strong({ phone_or_contact_form: ev({ phone: null, contact_form: true }, "x") });
      expect(points("phone_or_contact_form", formOnly)).toBe(5);
      const neither = strong({ phone_or_contact_form: ev({ phone: null, contact_form: false }, "x") });
      expect(points("phone_or_contact_form", neither)).toBe(0);
    });

    it("site maintained: newest dated content within 12 months of the scoring date", () => {
      const dated = (date: string) =>
        strong({ latest_dated_content: ev({ text: "post", date }, "x"), recent_signal: NOT_FOUND });
      expect(points("site_maintained", dated("2025-09-24"))).toBe(5);
      expect(points("site_maintained", dated("2025-09-22"))).toBe(0);
      expect(points("site_maintained", dated("2025-09"))).toBe(5); // month precision: benefit of the doubt
      expect(points("site_maintained", dated("2025-08"))).toBe(0);
    });

    it("site maintained also counts a dated recent_signal", () => {
      const d = strong({
        latest_dated_content: ev({ text: "old", date: "2020-01" }, "x"),
        recent_signal: ev({ text: "new hire", date: "2026-05" }, "x"),
      });
      expect(points("site_maintained", d)).toBe(5);
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
    expect(partialDateEnd("2025-12").toISOString()).toBe("2025-12-31T23:59:59.999Z");
    expect(partialDateEnd("2025-03-05").toISOString()).toBe("2025-03-05T23:59:59.999Z");
  });
});
