import {
  DossierSchema,
  EXTRACTION_TOOL_NAME,
  ExtractedFactsSchema,
  extractionInputSchema,
  FACT_FIELDS,
  NOT_FOUND,
} from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { ABOUT, emptyDossier, ev, HOME, strongDossier } from "./fixtures/dossiers";

function issues(value: unknown): string[] {
  const r = DossierSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("dossier schema: evidence enforcement", () => {
  it("accepts a fully evidenced dossier and an all-NOT_FOUND dossier", () => {
    expect(issues(strongDossier())).toEqual([]);
    expect(issues(emptyDossier())).toEqual([]);
  });

  it("rejects a quote longer than 15 words", () => {
    const quote = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen";
    const errs = issues(strongDossier({ firm_name: ev("Smith Tax Services", quote) }));
    expect(errs.join("\n")).toMatch(/firm_name.*15 words/);
  });

  it("accepts a quote of exactly 15 words", () => {
    const quote = "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen";
    expect(issues(strongDossier({ firm_name: ev("Smith Tax Services", quote) }))).toEqual([]);
  });

  it("rejects a value with no evidence (missing or empty url/quote)", () => {
    expect(issues(strongDossier({ firm_name: { value: "Smith Tax" } as never })).length).toBeGreaterThan(0);
    expect(issues(strongDossier({ firm_name: ev("Smith Tax", "") })).join()).toMatch(/evidence_quote is empty/);
    expect(issues(strongDossier({ firm_name: ev("Smith Tax", "Smith Tax", "") })).join()).toMatch(/evidence_url/);
  });

  it("rejects a bare value where an evidenced object or NOT_FOUND is required", () => {
    expect(issues(strongDossier({ firm_name: "Smith Tax Services" as never })).length).toBeGreaterThan(0);
    expect(issues(strongDossier({ firm_name: "not found" as never })).length).toBeGreaterThan(0);
  });

  it("rejects evidence from a page that was not opened", () => {
    const errs = issues(strongDossier({ firm_name: ev("Smith Tax", "Smith Tax", "https://elsewhere.example/") }));
    expect(errs.join()).toMatch(/firm_name.evidence_url.*not one of the pages opened/);
  });

  it("requires evidence_url 'pasted' for a pasted-text dossier", () => {
    const pasted = { ...emptyDossier(), source: "pasted" as const, pages_opened: [] };
    expect(issues({ ...pasted, firm_name: ev("Smith Tax", "Smith Tax", "pasted") })).toEqual([]);
    expect(issues({ ...pasted, firm_name: ev("Smith Tax", "Smith Tax", ABOUT) }).join()).toMatch(/must be "pasted"/);
  });

  it("requires DNS evidence in dns:<TYPE> <name> form", () => {
    const d = strongDossier();
    d.dns.dmarc_present = ev(false, "no record", "https://smithtax.example/");
    expect(issues(d).join()).toMatch(/dns.dmarc_present.evidence_url/);
  });

  it("only allows NOT_CHECKED for DKIM", () => {
    const d = strongDossier();
    (d.dns as Record<string, unknown>).dkim = ev(true, "v=DKIM1");
    expect(issues(d).length).toBeGreaterThan(0);
  });

  it("rejects firm types outside the docs/04 list and malformed dates", () => {
    expect(issues(strongDossier({ firm_type: ev("insurance" as never, "insurance") })).length).toBeGreaterThan(0);
    const bad = { value: { date: "Feb 2026", source: "time_element" as const }, evidence_url: HOME, evidence_quote: "Feb 2026" };
    expect(issues(strongDossier({ latest_dated_content: bad })).join()).toMatch(/YYYY-MM/);
  });

  it("rejects unknown fields (no smuggled extra claims)", () => {
    expect(issues({ ...strongDossier(), awards: ev("Best CPA", "Best CPA") }).length).toBeGreaterThan(0);
  });

  it("the model fills phone_or_contact_form, people, and exclusion_signals; code fills freshness, fit, and the gate", () => {
    expect(FACT_FIELDS).toEqual(expect.arrayContaining(["phone_or_contact_form", "people", "exclusion_signals"]));
    for (const codeField of ["latest_dated_content", "in_scope", "decision_maker", "us_location", "target_industry_fit", "gate"]) {
      expect(FACT_FIELDS).not.toContain(codeField);
    }
  });
});

describe("extraction tool schema (generated from zod)", () => {
  const schema = extractionInputSchema();

  it("is an inline object schema with every fact field required", () => {
    expect(EXTRACTION_TOOL_NAME).toMatch(/^[a-z_]+$/);
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("$schema");
    expect(JSON.stringify(schema)).not.toContain("$ref");
    expect(Object.keys(schema.properties as object).sort()).toEqual([...FACT_FIELDS].sort());
    expect([...(schema.required as string[])].sort()).toEqual([...FACT_FIELDS].sort());
    expect(schema.additionalProperties).toBe(false);
  });

  it("offers NOT_FOUND or an evidenced object for each field, with descriptions", () => {
    const firmName = (schema.properties as Record<string, Record<string, unknown>>).firm_name!;
    expect(firmName.description).toBeTruthy();
    const s = JSON.stringify(firmName);
    expect(s).toContain(NOT_FOUND);
    expect(s).toContain("evidence_url");
    expect(s).toContain("evidence_quote");
  });

  it("round-trips: data valid for the zod schema is what the tool schema describes", () => {
    const {
      lead_id,
      source,
      url,
      domain,
      pages_opened,
      failures,
      prompt_injection_flag,
      injection_findings,
      declined_automated_access,
      firm_name_candidates,
      public_email_kind,
      dns,
      security_mention_search,
      decision_maker,
      latest_dated_content,
      us_location,
      target_industry_fit,
      gate,
      ...facts
    } = strongDossier();
    void [lead_id, source, url, domain, pages_opened, failures, prompt_injection_flag, injection_findings, dns, security_mention_search];
    void [decision_maker, latest_dated_content, us_location, target_industry_fit, gate, declined_automated_access, firm_name_candidates, public_email_kind];
    expect(ExtractedFactsSchema.safeParse(facts).success).toBe(true);
  });

  it("does not let the model fill code-only fields (DNS, security keyword search)", () => {
    const props = Object.keys(extractionInputSchema().properties as object);
    expect(props).not.toContain("dns");
    expect(props).not.toContain("security_mention_search");
    for (const f of ["decision_maker", "latest_dated_content", "in_scope", "us_location", "target_industry_fit", "gate", "public_email_kind", "recent_signal"]) expect(props).not.toContain(f);
  });

  it("rejects a security search whose pages were not opened", () => {
    const d = strongDossier({ pages_opened: ["https://smithtax.example/"] });
    expect(issues(d).join()).toMatch(/security_mention_search.*not one of the pages opened/);
  });
});
