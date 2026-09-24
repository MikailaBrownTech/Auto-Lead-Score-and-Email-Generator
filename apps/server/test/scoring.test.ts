import { NOT_FOUND, type ScoringConfig } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadScoring } from "../src/docs/loader";
import { partialDateEnd, scoreDossier, tierFor } from "../src/scoring/score";
import { dnsEv, emptyDossier, ev, strongDossier } from "./fixtures/dossiers";

const config = loadScoring();
const AS_OF = new Date("2026-09-23T00:00:00.000Z");

function points(key: string, d = strongDossier(), c: ScoringConfig = config, asOf = AS_OF) {
  return scoreDossier(d, c, asOf).breakdown.find((b) => b.key === key)!.points;
}

describe("scoreDossier (docs/06)", () => {
  it("scores the strong fixture 90: every signal except 'no WISP mention'", () => {
    const r = scoreDossier(strongDossier(), config, AS_OF);
    expect(r.total).toBe(90);
    expect(r.tier).toBe("A");
    expect(r.breakdown.filter((b) => b.points === 0).map((b) => b.key)).toEqual(["no_wisp_mention"]);
  });

  it("scores an all-NOT_FOUND dossier 0 (NOT_FOUND is never a negative finding)", () => {
    const r = scoreDossier(emptyDossier(), config, AS_OF);
    expect(r.total).toBe(0);
    expect(r.tier).toBe("C");
    for (const b of r.breakdown) expect(b.reason).toMatch(/NOT_FOUND/);
  });

  it("is deterministic and pure", () => {
    const d = strongDossier();
    const snapshot = JSON.stringify(d);
    expect(scoreDossier(d, config, AS_OF)).toEqual(scoreDossier(d, config, AS_OF));
    expect(JSON.stringify(d)).toBe(snapshot);
  });

  it("uses the weights from the config, not constants", () => {
    const heavier = structuredClone(config);
    heavier.criteria.find((c) => c.key === "firm_type_in_target")!.points = 25;
    heavier.criteria.find((c) => c.key === "public_business_email")!.points = 0;
    expect(points("firm_type_in_target", strongDossier(), heavier)).toBe(25);
    expect(points("public_business_email", strongDossier(), heavier)).toBe(0);
  });

  describe("fit", () => {
    it("firm type: target types score, 'other' does not", () => {
      expect(points("firm_type_in_target")).toBe(15);
      expect(points("firm_type_in_target", strongDossier({ firm_type: ev("other" as const, "x") }))).toBe(0);
    });

    it("size: scores only a stated staff count within 3-30; no size signal scores 0", () => {
      const size = (n: number | null) => strongDossier({ size_signal: ev({ staff_count: n, text: "t" }, "t") });
      expect(points("size_in_range", size(3))).toBe(10);
      expect(points("size_in_range", size(30))).toBe(10);
      expect(points("size_in_range", size(2))).toBe(0);
      expect(points("size_in_range", size(31))).toBe(0);
      expect(points("size_in_range", size(null))).toBe(0);
      expect(points("size_in_range", strongDossier({ size_signal: NOT_FOUND }))).toBe(0);
    });

    it("US and in scope: only an evidenced true", () => {
      expect(points("us_in_scope")).toBe(5);
      expect(points("us_in_scope", strongDossier({ in_scope: ev(false, "x") }))).toBe(0);
    });

    it("decision maker named", () => {
      expect(points("decision_maker_named")).toBe(10);
      expect(points("decision_maker_named", strongDossier({ decision_maker: NOT_FOUND }))).toBe(0);
    });
  });

  describe("signals", () => {
    it("no WISP mention never scores: a found mention is the opposite, and absence is NOT_FOUND", () => {
      expect(points("no_wisp_mention", strongDossier({ security_or_wisp_mention: NOT_FOUND }))).toBe(0);
      expect(points("no_wisp_mention", strongDossier({ security_or_wisp_mention: ev("We maintain a WISP", "WISP") }))).toBe(0);
    });

    it("DMARC: missing record or policy=none scores; enforcing policy or NOT_FOUND does not", () => {
      const withDns = (present: unknown, policy: unknown) => {
        const d = strongDossier();
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

    it("personal email domain: only providers on the docs/06 list", () => {
      expect(points("personal_email_domain")).toBe(5);
      const firmDomain = strongDossier({ personal_email_domain_on_site: ev("jane@smithtax.example", "x") });
      expect(points("personal_email_domain", firmDomain)).toBe(0);
      const upper = strongDossier({ personal_email_domain_on_site: ev("Jane@Yahoo.com", "x") });
      expect(points("personal_email_domain", upper)).toBe(5);
    });

    it("sensitive data: keyword match on services, not inside other words", () => {
      const svc = (...s: string[]) => strongDossier({ services: ev(s, "x") });
      expect(points("sensitive_data_services", svc("Payroll processing"))).toBe(10);
      expect(points("sensitive_data_services", svc("Credit counseling"))).toBe(10);
      expect(points("sensitive_data_services", svc("Debt management plans"))).toBe(10);
      expect(points("sensitive_data_services", svc("Syntax consulting", "Web design"))).toBe(0);
    });

    it("doc exchange without a secure portal", () => {
      const f = (doc_exchange: boolean, secure_portal: boolean) =>
        strongDossier({ client_portal_or_doc_exchange: ev({ doc_exchange, secure_portal }, "x") });
      expect(points("doc_exchange_without_portal", f(true, false))).toBe(5);
      expect(points("doc_exchange_without_portal", f(true, true))).toBe(0);
      expect(points("doc_exchange_without_portal", f(false, false))).toBe(0);
    });
  });

  describe("reachability", () => {
    it("public business email and phone/contact form", () => {
      expect(points("public_business_email")).toBe(10);
      expect(points("phone_or_contact_form")).toBe(5);
      const formOnly = strongDossier({ phone_or_contact_form: ev({ phone: null, contact_form: true }, "x") });
      expect(points("phone_or_contact_form", formOnly)).toBe(5);
      const neither = strongDossier({ phone_or_contact_form: ev({ phone: null, contact_form: false }, "x") });
      expect(points("phone_or_contact_form", neither)).toBe(0);
    });

    it("site maintained: newest dated content within 12 months of the scoring date", () => {
      const dated = (date: string) =>
        strongDossier({ latest_dated_content: ev({ text: "post", date }, "x"), recent_signal: NOT_FOUND });
      expect(points("site_maintained", dated("2025-09-24"))).toBe(5);
      expect(points("site_maintained", dated("2025-09-22"))).toBe(0);
      expect(points("site_maintained", dated("2025-09"))).toBe(5); // month precision: benefit of the doubt
      expect(points("site_maintained", dated("2025-08"))).toBe(0);
    });

    it("site maintained also counts a dated recent_signal", () => {
      const d = strongDossier({
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
