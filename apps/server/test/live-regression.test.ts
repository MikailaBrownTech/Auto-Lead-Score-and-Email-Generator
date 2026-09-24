import { DossierSchema, isFound, type Dossier } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadEvidence, loadScoring } from "../src/docs/loader";
import type { ResearchReport } from "../src/pipeline/research";
import { replay } from "./fixtures/replay";
import { contactPlan } from "../src/scoring/contact";

const scoring = loadScoring();
const evidence = loadEvidence();
const FAMILY = /\b(wife|husband|mother|father|mom|dad|kids|children|boys|girls|son|sons|daughter|daughters|married|pregnant|church)\b/i;

/** Every evidence quote stored anywhere in the dossier. */
function allQuotes(d: Dossier): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "evidence_quote" && typeof x === "string") out.push(x);
        else visit(x);
      }
    }
  };
  visit(d);
  return out;
}

function commonChecks(r: ResearchReport) {
  // Without a person-tied public address (generic, unattributed, or none), a lead is labeled no_named_contact (a warning).
  expect(r.status).toBe(r.dossier.public_email_kind === "named_person" ? "extracted" : "no_named_contact");
  expect(DossierSchema.safeParse(r.dossier).success).toBe(true);
  const search = r.dossier.security_mention_search;
  if (search !== "NOT_CHECKED") expect(search.matches.map((m) => m.keyword)).not.toContain("secure portal");
  for (const q of allQuotes(r.dossier)) expect(q, "stored quote with family details").not.toMatch(FAMILY);
  // Only code may record an absence: no model boolean is ever false.
  const d = r.dossier;
  expect(JSON.stringify([d.privacy_policy_present, d.client_portal_or_doc_exchange, d.phone_or_contact_form]), "model boolean set to false").not.toMatch(/false/);
}

// Real pages are large; jsdom parsing makes these slower than unit tests.
describe("live regression: sites recorded from the real web (replayed offline)", { timeout: 30_000 }, () => {
  it("Pease Bell: out_of_icp on size", async () => {
    const r = await replay("peasebell-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("out_of_icp");
    expect(r.dossier.gate.reasons.join()).toMatch(/staff count \d+ is above max_staff_for_sequence 60/);
    // Signal points never count for an out_of_icp lead.
    expect(r.score.breakdown.filter((b) => b.group === "signals").every((b) => b.points === 0)).toBe(true);
  });

  it("Charles E. Harris (cehcpas): needs_review for government/nonprofit-only work", async () => {
    const r = await replay("cehcpas-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("needs_review");
    expect(r.dossier.exclusion_signals.map((s) => s.signal)).toContain("government_or_nonprofit_only");
    // An audit firm fits the target industry ("audits" in the verified services is a CPA keyword).
    expect(r.dossier.target_industry_fit.value).toBe(true);
  });

  it("Inner Circle (innercircle.cpa): qualified; the 403 on the team page stops the crawl and asks for pasted text", async () => {
    const r = await replay("innercircle-cpa");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("qualified");
    expect(r.dossier.declined_automated_access).toBe(true);
    expect(r.dossier.failures.join("\n")).toMatch(/declined_automated_access: https:\/\/innercircle\.cpa\/meet-our-team\/ answered HTTP 403.*Paste the site text/);
    // Nothing after the 403 was requested: only the pages fetched before it were opened.
    expect(r.dossier.pages_opened).toEqual(["https://innercircle.cpa/", "https://innercircle.cpa/about-our-cpa-services/"]);
    // Too few pages for the no-WISP search to count.
    expect(r.score.breakdown.find((b) => b.key === "no_wisp_mention")!.points).toBe(0);
    // firm_name from the og:site_name candidate; firm_type recovered by cutting the over-long verbatim quote.
    expect(r.dossier.firm_name).toMatchObject({ value: "Inner Circle Advisors" });
    expect(r.dossier.firm_type).toMatchObject({ value: { primary: "cpa" } });
    // marketing@ is a generic inbox: partial points and a neutral greeting.
    expect(r.dossier.public_email_kind).toBe("generic_inbox");
    expect(r.score.breakdown.find((b) => b.key === "public_business_email")!.points).toBe(5);
    expect(contactPlan(r.dossier)).toMatchObject({ greeting: null, genericInbox: true });
  });

  it("RBV Financial: qualifies only through tax preparation; no DMARC points; no family details; no secure-portal WISP hit", async () => {
    const r = await replay("rbvfinancial-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("qualified");
    expect(r.dossier.target_industry_fit).toMatchObject({ value: true, qualifying_type: "tax_preparer" });
    expect(isFound(r.dossier.firm_type) && r.dossier.firm_type.value.primary).toBe("credit_repair");
    expect(r.dossier.dns.no_domain_email).toMatchObject({ value: true });
    expect(r.score.breakdown.find((b) => b.key === "dmarc_missing_or_none")!.points).toBe(0);
    // The owner is named with a professional quote, never the family sentence.
    if (isFound(r.dossier.decision_maker)) expect(r.dossier.decision_maker.evidence_quote).not.toMatch(FAMILY);
    // The public address is a shared gmail box, not tied to a named person: neutral greeting, partial points.
    expect(contactPlan(r.dossier)).toMatchObject({ greeting: null });
    expect(r.dossier.public_email_kind).not.toBe("named_person");
    expect(r.score.breakdown.find((b) => b.key === "public_business_email")!.points).toBe(5);
  });

  it("essentialacctg: a client count is not a staff size; generic inbox is labeled no_named_contact", async () => {
    const r = await replay("essentialacctg-com");
    commonChecks(r);
    expect(r.status).toBe("no_named_contact");
    expect(r.dossier.public_email_kind).toBe("generic_inbox");
    expect(r.dossier.size_signal).toBe("NOT_FOUND");
    expect(r.dossier.client_count_signal).toMatchObject({ value: { text: expect.stringMatching(/Companies/) } });
    // Uploaded images with dated paths are neither the news page nor a freshness date.
    const uploads = r.links.filter((l) => l.url.includes("/wp-content/uploads/"));
    expect(uploads.length).toBeGreaterThan(0);
    expect(uploads.every((l) => l.kind !== "news")).toBe(true);
    const fresh = r.dossier.latest_dated_content;
    if (isFound(fresh)) expect(fresh.evidence_url).not.toMatch(/wp-content\/uploads|\.png$/);
  });

  it("metaxparma: tax_preparer (model or code) and target industry fit; long services list kept; no false booleans", async () => {
    const r = await replay("metaxparma-com");
    commonChecks(r);
    expect(isFound(r.dossier.firm_type) && r.dossier.firm_type.value.primary).toBe("tax_preparer");
    expect(isFound(r.dossier.firm_type) && ["model", "code"]).toContain(isFound(r.dossier.firm_type) && (r.dossier.firm_type.value.source ?? "model"));
    expect(r.dossier.target_industry_fit.value).toBe(true);
    expect(isFound(r.dossier.services) && r.dossier.services.value.length).toBeGreaterThan(15);
    expect(r.dossier.privacy_policy_present).not.toMatchObject({ value: false });
    expect(r.status).toBe("no_named_contact");
  });

  it("mapaccountinggroup: no public email is labeled no_named_contact; DMARC reports hint at an existing IT provider (internal)", async () => {
    const r = await replay("mapaccountinggroup-com");
    commonChecks(r);
    expect(r.dossier.public_contact_email).toBe("NOT_FOUND");
    expect(r.status).toBe("no_named_contact");
    expect(r.dossier.email_security_hint).toMatchObject({ outside_domains: ["mynetworkplace.net"] });
    expect(r.score.incompleteData.flag).toBe(true);
  });
});
