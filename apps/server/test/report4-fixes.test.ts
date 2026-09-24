import { DossierSchema, NOT_FOUND, type Dossier } from "@clearpath/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { exitDecision } from "../scripts/exit";
import { openDb, type Db } from "../src/db/client";
import { leadEvents, leads } from "../src/db/schema";
import { dmarcReportDomains, emailSecurityHint, loadDmarcVendors } from "../src/dns/lookup";
import { loadApprovedSentences, loadEvidence, loadOffer, loadScoring, loadStyle, loadWriterFacts } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { dropFalseBooleans, isClientCount, verifyExtraction } from "../src/extract/verify";
import { classifyPage } from "../src/fetch/select";
import { firmTypeFromKeywords, keywordQuote } from "../src/scoring/derive";
import { directContactBlockers, directContactChecklist, leadOverride, overrideDirectContact } from "../src/scoring/direct-contact";
import { computeFreshness, urlPathDate } from "../src/scoring/freshness";
import { scoreDossier } from "../src/scoring/score";
import { approveSequence, generateSequence, type WriteDeps } from "../src/write/generate";
import { loadPersonaHeadings, writerMessage } from "../src/write/prompt";
import { planSequence } from "../src/write/writer-input";
import { ev, HOME, strongDossier } from "./fixtures/dossiers";

const evidence = loadEvidence();
const scoring = loadScoring();
const offer = loadOffer();
const NOW = new Date("2026-09-24T12:00:00Z");
const pagesOf = (text: string, title = "") => ({ pages: new Map([[HOME, { text, title }]]), evidence });

describe("exit codes", () => {
  it("exit 0 for every expected outcome; non-zero only for real errors, with the reason", () => {
    const expected = (["extracted", "needs_direct_contact", "budget_exceeded"] as const).map((status) => ({ leadId: `L-${status}`, status, error: null }));
    expect(exitDecision(expected)).toEqual({ code: 0, because: null });
    expect(exitDecision([...expected, { leadId: "L9", status: "failed", error: "TypeError: boom" }])).toEqual({ code: 1, because: "L9 failed: TypeError: boom" });
  });
});

describe("list fields: never rejected for length", () => {
  it("keeps the first 25 items found and drops the rest without a retry", () => {
    const items = Array.from({ length: 30 }, (_, i) => `Service number ${i + 1}`);
    const text = items.join("\n\n");
    const v = verifyExtraction({ services: items }, pagesOf(text));
    expect(v.checks.services.status).toBe("verified");
    expect(v.facts.services).toMatchObject({ value: items.slice(0, 25) });
    expect(v.checks.services.notes).toContain("services: kept the first 25 items found; dropped 5 more");
    expect(v.checks.services.partial).toBeUndefined();
  });
});

describe("firm_type fallback from docs/06 keywords", () => {
  const text = "M.E. and Associates Services\n\nWe offer tax preparation, tax returns for individuals and businesses, bookkeeping, and payroll.\n\nElectronic filing is always free.";

  it("derives the type with the most keyword hits, with a verbatim quote, marked source=code", () => {
    const services = { value: ["Individual", "Payroll processing"], evidence: [{ item: "Individual", evidence_url: HOME }, { item: "Payroll processing", evidence_url: HOME }] };
    const ft = firmTypeFromKeywords([{ url: HOME, text }], services, evidence);
    expect(ft).toMatchObject({ value: { primary: "tax_preparer", source: "code" }, evidence_url: HOME });
    if (ft === NOT_FOUND) throw new Error("expected a type");
    expect(ft.evidence_quote.split(" ").length).toBeLessThanOrEqual(15);
    expect(text.replace(/\s+/g, " ")).toContain(ft.evidence_quote);
    expect(ft.value.secondary).toContain("payroll");
  });

  it("tries the type the model named first, but only with the code's own keyword quote", () => {
    const payrollHeavy = { value: ["Payroll Processing", "Payroll Taxes"], evidence: [{ item: "Payroll Processing", evidence_url: HOME }, { item: "Payroll Taxes", evidence_url: HOME }] };
    const pages = [{ url: HOME, text: "Payroll Processing\n\nPayroll Taxes\n\nWe handle tax preparation for local families." }];
    expect(firmTypeFromKeywords(pages, payrollHeavy, evidence)).toMatchObject({ value: { primary: "payroll" } });
    expect(firmTypeFromKeywords(pages, payrollHeavy, evidence, "tax_preparer")).toMatchObject({ value: { primary: "tax_preparer", source: "code" }, evidence_quote: expect.stringContaining("tax preparation") });
    // A proposed type with no keyword on the pages is not taken on the model's word.
    expect(firmTypeFromKeywords(pages, payrollHeavy, evidence, "collections")).toMatchObject({ value: { primary: "payroll" } });
  });

  it("returns NOT_FOUND when no keyword appears; never quotes personal details", () => {
    expect(firmTypeFromKeywords([{ url: HOME, text: "We build websites." }], NOT_FOUND, evidence)).toBe(NOT_FOUND);
    expect(keywordQuote("My wife and I do tax preparation.", "tax preparation", evidence.personal_terms)).toBeNull();
  });
});

describe("absence claims: only code may set a boolean to false", () => {
  it("metaxparma: a copyright line answered as privacy_policy_present=false becomes NOT_FOUND", () => {
    const quote = "All rights reserved. © 2025 by M.E. and Associates Services.";
    const v = verifyExtraction({ privacy_policy_present: ev(false, quote) }, pagesOf(`Home\n\n${quote}`));
    expect(v.checks.privacy_policy_present.status).toBe("not_found");
    expect(v.facts.privacy_policy_present).toBe(NOT_FOUND);
    expect(v.checks.privacy_policy_present.notes).toEqual(["privacy_policy_present: the model answered false; only code may record an absence (false dropped)"]);
  });

  it("false inside objects becomes null; nothing true left means NOT_FOUND", () => {
    expect(dropFalseBooleans("client_portal_or_doc_exchange", ev({ doc_exchange: true, secure_portal: false }, "x")).answer).toMatchObject({ value: { doc_exchange: true, secure_portal: null } });
    expect(dropFalseBooleans("client_portal_or_doc_exchange", ev({ doc_exchange: false, secure_portal: false }, "x")).answer).toBeNull();
    expect(dropFalseBooleans("phone_or_contact_form", ev({ phone: "(440) 885-0829", contact_form: false }, "x")).answer).toMatchObject({ value: { contact_form: null } });
    expect(dropFalseBooleans("phone_or_contact_form", ev({ phone: null, contact_form: false }, "x")).answer).toBeNull();
  });

  it("the dossier schema itself refuses a model boolean set to false", () => {
    const bad = { ...strongDossier(), privacy_policy_present: ev(false, "x") };
    expect(DossierSchema.safeParse(bad).success).toBe(false);
  });
});

describe("size_signal is staff only", () => {
  it("a count of companies served moves to client_count_signal (not scored)", () => {
    const quote = "We've Empowered More Than 1,000+ Companies With Our Financial Services";
    const v = verifyExtraction({ size_signal: ev({ staff_count: 1000, text: quote }, quote) }, pagesOf(quote));
    expect(v.facts.size_signal).toBe(NOT_FOUND);
    expect(v.facts.client_count_signal).toMatchObject({ value: { count: 1000 } });
    expect(isClientCount("our staff is prepared to help you", "our staff is prepared")).toBe(false);
    expect(isClientCount("serving 400 families each year", "400 families")).toBe(true);
  });
});

describe("URL-date freshness ignores uploads and files", () => {
  it("ignores /wp-content/uploads/ and non-HTML extensions", () => {
    expect(urlPathDate("https://a.example/wp-content/uploads/2026/04/20/unnamed-1/")).toBeNull();
    expect(urlPathDate("https://a.example/2026/04/20/brochure.pdf")).toBeNull();
    expect(urlPathDate("https://a.example/2026/04/20/logo.png")).toBeNull();
    expect(urlPathDate("https://a.example/2026/04/20/new-hire/")).toBe("2026-04-20");
    const upload = { url: "https://a.example/wp-content/uploads/2026/04/20/photo/", kind: "other" as const, dates: [] };
    expect(computeFreshness([upload], null, NOW)).toBe(NOT_FOUND);
  });

  it("an uploaded image is never classified as the news page", () => {
    expect(classifyPage(new URL("https://essentialacctg.com/wp-content/uploads/2024/03/6-2.png"))).not.toBe("news");
    expect(classifyPage(new URL("https://a.example/2024/03/14/tax-season-update/"))).toBe("news");
  });
});

describe("email_security_hint (internal only)", () => {
  const vendors = loadDmarcVendors();
  const record = "v=DMARC1; p=quarantine; rua=mailto:bob@mynetworkplace.net; ruf=mailto:bob@mynetworkplace.net; pct=100; fo=1;";

  it("flags DMARC reports sent to an outside domain that is not a known vendor", () => {
    expect(dmarcReportDomains(record, "rua")).toEqual(["mynetworkplace.net"]);
    expect(emailSecurityHint(record, "mapaccountinggroup.com", vendors)).toMatchObject({
      outside_domains: ["mynetworkplace.net"],
      note: "possible existing IT provider: DMARC reports go to mynetworkplace.net",
      evidence_url: "dns:TXT _dmarc.mapaccountinggroup.com",
    });
  });

  it("ignores the firm's own domain and DMARC vendors", () => {
    expect(emailSecurityHint("v=DMARC1; p=none; rua=mailto:dmarc@smithtax.example", "smithtax.example", vendors)).toBe(NOT_FOUND);
    expect(emailSecurityHint("v=DMARC1; p=none; rua=mailto:x@ag.dmarcian.com,mailto:y@rua.easydmarc.us", "smithtax.example", vendors)).toBe(NOT_FOUND);
    expect(emailSecurityHint(null, "smithtax.example", vendors)).toBe(NOT_FOUND);
  });

  it("never reaches the writer", () => {
    const hint = emailSecurityHint(record, "smithtax.example", vendors);
    const d = strongDossier({ email_security_hint: hint });
    const plan = planSequence(d, [1, 2], { offer, evidence, style: loadStyle(), approved: loadApprovedSentences().sentences, personas: loadPersonaHeadings(), greeting: "Hi," });
    expect(JSON.stringify(plan)).not.toMatch(/mynetworkplace|IT provider/);
    expect(writerMessage(plan, 5)).not.toMatch(/mynetworkplace|IT provider/);
  });
});

describe("incomplete_data", () => {
  it("flags a low tier caused mainly by NOT_FOUND facts, without raising the score", () => {
    const d = strongDossier({ size_signal: NOT_FOUND, decision_maker: NOT_FOUND, people: [], public_contact_email: NOT_FOUND, public_email_kind: NOT_FOUND, services: NOT_FOUND, phone_or_contact_form: NOT_FOUND });
    const s = scoreDossier(d, scoring, NOW);
    expect(s.tier).not.toBe("A");
    expect(s.incompleteData).toMatchObject({ flag: true });
    expect(s.incompleteData.criteria).toEqual(expect.arrayContaining(["size_in_range", "decision_maker_named", "public_business_email"]));
    expect(s.incompleteData.reason).toMatch(/paste mode/);
    expect(s.total).toBe(scoreDossier(d, scoring, NOW).total);
  });

  it("does not flag a tier that reflects findings", () => {
    expect(scoreDossier(strongDossier(), scoring, NOW).incompleteData.flag).toBe(false);
    const outOfRange = strongDossier({ size_signal: ev({ staff_count: 45, text: "45 staff" }, "45 staff"), dns: { ...strongDossier().dns, dmarc_present: ev(true, "v=DMARC1"), dmarc_policy: ev("reject" as const, "p=reject") } as never });
    expect(scoreDossier(outOfRange, scoring, NOW).incompleteData.flag).toBe(false);
  });
});

describe("needs_direct_contact and per-lead override", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("any lead without a person-tied public email needs a direct contact, including no email at all", () => {
    const none = strongDossier({ public_contact_email: NOT_FOUND, public_email_kind: NOT_FOUND });
    const unattributed = strongDossier({ public_email_kind: "unattributed" });
    expect(directContactBlockers(none, offer, null).join()).toMatch(/^needs_direct_contact: no public email address was found/);
    expect(directContactBlockers(unattributed, offer, null).join()).toMatch(/is not tied to a named person/);
    expect(directContactBlockers(strongDossier(), offer, null)).toEqual([]);
    expect(directContactBlockers(none, { ...offer, allow_without_direct_contact: true }, null)).toEqual([]);
    const checklist = directContactChecklist(none).join("\n");
    for (const s of ["paste mode", "accountancy board license lookup", "Secretary of State business search", "Google Business Profile"]) expect(checklist).toContain(s);
  });

  it("an override needs a reason, is logged, clears the status, allows approval, and forces the neutral greeting", async () => {
    const d = strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox" });
    db.insert(leads).values({ id: "L1", source: "web", status: "needs_direct_contact", dossierJson: JSON.stringify(d) }).run();
    expect(() => overrideDirectContact(db, "L1", "ok")).toThrow(/reason/);
    const o = overrideDirectContact(db, "L1", "Solo practice; info@ is the owner's only inbox", () => NOW);
    expect(leadOverride(db, "L1")).toEqual(o);
    expect(db.select().from(leads).where(eq(leads.id, "L1")).get()!.status).toBe("extracted");
    expect(db.select().from(leadEvents).all()).toMatchObject([{ leadId: "L1", kind: "direct_contact_override", detail: "Solo practice; info@ is the owner's only inbox" }]);

    const deps = {
      db,
      llm: {} as WriteDeps["llm"],
      modelWrite: "unused",
      writerSystem: "",
      judgeSystem: "",
      style: loadStyle(),
      offer,
      evidence,
      templates: loadTemplates(),
      facts: loadWriterFacts(),
      approved: loadApprovedSentences().sentences,
      personas: loadPersonaHeadings(),
    };
    const named = strongDossier(); // would normally greet "Hi Jane,"
    const r = await generateSequence("L1", named, "C", deps, { directContactOverride: o });
    for (const e of r.sequence!.emails) expect(e.body.startsWith("Hi,\n")).toBe(true);
    const g = await generateSequence("L1", d, "C", deps, { directContactOverride: o });
    expect(g.approvalBlockers).toEqual([]);
    approveSequence(db, g.sequenceId!, offer);
  });
});

describe("dossier fixtures stay honest", () => {
  it("strongDossier has no model boolean set to false", () => {
    const d: Dossier = strongDossier();
    expect(JSON.stringify([d.privacy_policy_present, d.client_portal_or_doc_exchange, d.phone_or_contact_form])).not.toContain("false");
  });
});
