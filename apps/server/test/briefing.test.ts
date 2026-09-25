import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadScoring } from "../src/docs/loader";
import { buildBriefing, loadBriefingConfig, type BriefingLine, type BriefingTopic } from "../src/pipeline/briefing";
import { scoreDossier, type CriterionResult, type ScoreResult } from "../src/scoring/score";
import { strongDossier } from "./fixtures/dossiers";

const cfg = loadBriefingConfig();
const scoring = loadScoring();

function textOf(lines: BriefingLine[], topic: BriefingTopic): string | undefined {
  return lines.find((l) => l.topic === topic)?.text;
}

/** A minimal ScoreResult: only what buildBriefing reads (breakdown by key, incompleteData.flag). */
function fakeScore(met: string[], incompleteFlag = false): ScoreResult {
  const breakdown: CriterionResult[] = met.map((key) => ({ key: key as CriterionResult["key"], group: "signals", label: key, max: 10, points: 10, reason: "met", fields: [], dataMissing: false }));
  return {
    total: 0,
    tier: "B",
    fitPoints: 0,
    tierCapped: false,
    gate: { status: "qualified", reasons: [] },
    breakdown,
    incompleteData: { flag: incompleteFlag, notFoundPoints: 0, otherLostPoints: 0, criteria: [], reason: incompleteFlag ? "test" : "not incomplete" },
  };
}

describe("config/briefing.json loads with every template and firm type label", () => {
  it("loadBriefingConfig succeeds against the real config file", () => {
    expect(cfg.footer_note).toMatch(/public web pages and DNS records/);
    expect(cfg.firm_type_labels.cpa).toBeTruthy();
  });
});

describe("buildBriefing: end to end against the real scoring config", () => {
  it("a fully-found, in-range, qualified lead gets fit, contact, services, security, wisp, and freshness lines", () => {
    // The real config's wisp_keywords (not the fixture default) so no_wisp_mention actually scores.
    const d = strongDossier({}, scoring.wisp_keywords);
    const score = scoreDossier(d, scoring, new Date("2026-03-01"));
    const b = buildBriefing(d, score, cfg);

    expect(textOf(b.lines, "fit")).toBe("Smith Tax Services is a 6-person tax preparation firm in Columbus, which fits your target size.");
    expect(textOf(b.lines, "contact")).toBe("Jane Smith (Owner) is listed as the decision maker, reachable at jane@smithtax.example.");
    expect(textOf(b.lines, "services")).toBe("They offer 2 services, including Individual tax returns, Payroll services, so they likely handle sensitive client data.");
    expect(textOf(b.lines, "security")).toBe("Their domain has no DMARC record, so email spoofing protection isn't set up.");
    expect(textOf(b.lines, "wisp")).toBe("No mention of a written security plan found anywhere on their site (checked 3 pages).");
    expect(textOf(b.lines, "freshness")).toBe("Their site was last updated around 2026-02-10.");
    expect(textOf(b.lines, "access")).toBeUndefined();
    expect(b.note).toBe(cfg.footer_note);
  });
});

describe("buildBriefing: one branch per major case", () => {
  it("FIT: out_of_icp on size shows the over-range line, not the fit line", () => {
    const d = strongDossier({
      size_signal: { value: { staff_count: 150, text: "150 employees" }, evidence_url: "https://smithtax.example/about", evidence_quote: "150 employees" },
      gate: { status: "out_of_icp", reasons: ["staff count 150 is above max_staff_for_sequence 60"] },
    });
    const b = buildBriefing(d, fakeScore(["size_in_range"]), cfg);
    expect(textOf(b.lines, "fit")).toBe("This firm is larger than your target range (150 staff).");
  });

  it("FIT: skipped (not asserted) when size_in_range never scored", () => {
    const d = strongDossier();
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(textOf(b.lines, "fit")).toBeUndefined();
  });

  it("CONTACT: a named, confirmed contact with a title", () => {
    const d = strongDossier();
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(textOf(b.lines, "contact")).toBe("Jane Smith (Owner) is listed as the decision maker, reachable at jane@smithtax.example.");
  });

  it("CONTACT: an unconfirmed role, no title", () => {
    const d = strongDossier({ decision_maker: { value: { name: "Alex Rivera", title: null, role_confirmed: false }, evidence_url: "https://smithtax.example/about", evidence_quote: "Alex Rivera" } });
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(textOf(b.lines, "contact")).toBe("Alex Rivera is listed as a likely contact (their role isn't confirmed), reachable at jane@smithtax.example.");
  });

  it("CONTACT: a generic inbox, no named person", () => {
    const d = strongDossier({
      public_contact_email: { value: { address: "info@smithtax.example", owner_name: null }, evidence_url: "https://smithtax.example/", evidence_quote: "info@smithtax.example" },
      public_email_kind: "generic_inbox",
    });
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(textOf(b.lines, "contact")).toBe("No named contact found; only a general inbox (info@smithtax.example) is public.");
  });

  it("CONTACT: no public email at all", () => {
    const d = strongDossier({ public_contact_email: NOT_FOUND, public_email_kind: NOT_FOUND });
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(textOf(b.lines, "contact")).toBe("No public email was found for this firm at all.");
  });

  it("SERVICES: only shown when sensitive_data_services actually scored", () => {
    const d = strongDossier();
    expect(textOf(buildBriefing(d, fakeScore(["sensitive_data_services"]), cfg).lines, "services")).toContain("They offer 2 services");
    expect(textOf(buildBriefing(d, fakeScore([]), cfg).lines, "services")).toBeUndefined();
  });

  it("SECURITY: all 4 DMARC/MX cases", () => {
    const noMail = strongDossier({ dns: { ...strongDossier().dns, no_domain_email: { value: true, evidence_url: "dns:MX smithtax.example", evidence_quote: "no MX" } } });
    expect(textOf(buildBriefing(noMail, fakeScore([]), cfg).lines, "security")).toBe("This domain has no mail servers set up, so email authentication (DMARC) doesn't apply.");

    const noDmarc = strongDossier(); // dmarc_present: false by default
    expect(textOf(buildBriefing(noDmarc, fakeScore([]), cfg).lines, "security")).toBe("Their domain has no DMARC record, so email spoofing protection isn't set up.");

    const monitoring = strongDossier({
      dns: { ...strongDossier().dns, dmarc_present: { value: true, evidence_url: "dns:TXT _dmarc.smithtax.example", evidence_quote: "v=DMARC1; p=none" }, dmarc_policy: { value: "none", evidence_url: "dns:TXT _dmarc.smithtax.example", evidence_quote: "p=none" } },
    });
    expect(textOf(buildBriefing(monitoring, fakeScore([]), cfg).lines, "security")).toBe("They have a DMARC record, but it's set to monitoring only, not enforced.");

    const enforced = strongDossier({
      dns: { ...strongDossier().dns, dmarc_present: { value: true, evidence_url: "dns:TXT _dmarc.smithtax.example", evidence_quote: "v=DMARC1; p=reject" }, dmarc_policy: { value: "reject", evidence_url: "dns:TXT _dmarc.smithtax.example", evidence_quote: "p=reject" } },
    });
    expect(textOf(buildBriefing(enforced, fakeScore([]), cfg).lines, "security")).toBe("Their domain has DMARC enforcement in place.");
  });

  it("SECURITY: skipped when the MX lookup failed (no_domain_email NOT_FOUND)", () => {
    const d = strongDossier({ dns: { ...strongDossier().dns, no_domain_email: NOT_FOUND } });
    expect(textOf(buildBriefing(d, fakeScore([]), cfg).lines, "security")).toBeUndefined();
  });

  it("WISP: only when no_wisp_mention actually scored", () => {
    const d = strongDossier();
    expect(textOf(buildBriefing(d, fakeScore(["no_wisp_mention"]), cfg).lines, "wisp")).toBe("No mention of a written security plan found anywhere on their site (checked 3 pages).");
    expect(textOf(buildBriefing(d, fakeScore([]), cfg).lines, "wisp")).toBeUndefined();
  });

  it("FRESHNESS: a known date, and an unknown one, both only when site_maintained is scored", () => {
    const known = strongDossier();
    expect(textOf(buildBriefing(known, fakeScore(["site_maintained"]), cfg).lines, "freshness")).toBe("Their site was last updated around 2026-02-10.");
    const unknown = strongDossier({ latest_dated_content: NOT_FOUND });
    expect(textOf(buildBriefing(unknown, fakeScore(["site_maintained"]), cfg).lines, "freshness")).toBe("Couldn't confirm when their site was last updated.");
    expect(textOf(buildBriefing(unknown, fakeScore([]), cfg).lines, "freshness")).toBeUndefined();
  });

  it("ACCESS NOTES: declined automated access", () => {
    const d = strongDossier({ declined_automated_access: true });
    const b = buildBriefing(d, fakeScore([]), cfg);
    expect(b.lines.filter((l) => l.topic === "access").map((l) => l.text)).toEqual(["Their site blocked automated access; some fields may be incomplete."]);
  });

  it("ACCESS NOTES: incomplete data, and both notes together", () => {
    const d = strongDossier({ declined_automated_access: true });
    const b = buildBriefing(d, fakeScore([], true), cfg);
    expect(b.lines.filter((l) => l.topic === "access").map((l) => l.text)).toEqual([
      "Their site blocked automated access; some fields may be incomplete.",
      "This lead needs more info before it can be marked ready; consider paste mode.",
    ]);
  });

  it("never states a NOT_FOUND field: an empty dossier gets no lines at all", () => {
    const d = strongDossier({
      firm_name: NOT_FOUND,
      firm_type: NOT_FOUND,
      location: NOT_FOUND,
      size_signal: NOT_FOUND,
      services: NOT_FOUND,
      decision_maker: NOT_FOUND,
      public_contact_email: NOT_FOUND,
      public_email_kind: NOT_FOUND,
      latest_dated_content: NOT_FOUND,
      security_mention_search: "NOT_CHECKED",
      dns: { mx_provider: NOT_FOUND, no_domain_email: NOT_FOUND, spf_present: NOT_FOUND, dmarc_present: NOT_FOUND, dmarc_policy: NOT_FOUND, dkim: "NOT_CHECKED" },
    });
    const b = buildBriefing(d, fakeScore([]), cfg);
    // contact still says something (no email at all is a real, evidenced fact: NOT_FOUND on the email itself).
    expect(b.lines.map((l) => l.topic)).toEqual(["contact"]);
    expect(textOf(b.lines, "contact")).toBe("No public email was found for this firm at all.");
  });
});
