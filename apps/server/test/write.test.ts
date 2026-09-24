import { FIRM_TYPES, NOT_FOUND, type Dossier, type FirmType, type OfferConfig, type Sequence } from "@clearpath/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leads, runs, sequences } from "../src/db/schema";
import { parseTemplates } from "../src/docs/templates";
import { bodySentences, renderEmail, validateSequence } from "../src/validators/email";
import { assembleEmails } from "../src/write/assemble";
import { checkEdits, rewriteOne, runJudge, saveEdits } from "../src/write/edit";
import { approveSequence, buildSequence, exportBlockers, generateSequence, validationContext, type WriteDeps } from "../src/write/generate";
import { firmShort, renderSettings, renderSignature } from "../src/write/merge";
import { validatePersonalLine } from "../src/write/personal-line";
import { verifiedValues } from "../src/write/values";
import { ev, strongDossier } from "./fixtures/dossiers";
import { approved, evidence, offer, READY_OFFER, scripted, style, templates, testWriteDeps } from "./fixtures/write-deps";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

// strongDossier: Smith Tax Services (tax_preparer), Columbus OH, services "Individual tax returns" and
// "Payroll services", decision maker Jane Smith with jane@ (tied to her), software Drake, a team of six.
const generic = (over: Partial<Dossier> = {}) =>
  strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox", ...over });
const ofType = (primary: FirmType, d: Dossier = generic()): Dossier => ({
  ...d,
  firm_type: ev({ primary, secondary: [] }, "firm type quote"),
  target_industry_fit: { value: true, reason: "test", qualifying_type: primary },
});
const GOOD_LINE = "Smith Tax Services handles individual tax returns, which means holding a lot of sensitive client financial data.";
const saveLead = (id: string, d: Dossier) => db.insert(leads).values({ id, source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();
const values = (d: Dossier) => verifiedValues(d, offer, evidence).prospect_facts;
const build = (d: Dossier, line = GOOD_LINE, source: "model" | "fallback" = "model", firstName: string | null = null) =>
  assembleEmails({ dossier: d, templates, style, approved, personalLine: { text: line, source }, firstName, subjectChoice: null, values: values(d) });
const seqOf = (d: Dossier, firstName: string | null = null): Sequence => ({
  lead_id: "L1",
  tier: "B",
  persona: "p",
  angle: style.firm_type_angles.tax_preparer[0]!,
  emails: build(d, GOOD_LINE, "model", firstName),
});
const errorsOf = (s: Sequence, d: Dossier, o: OfferConfig = READY_OFFER) => validateSequence(s, { style, offer: o, dossier: d }).issues.filter((i) => i.severity === "error");

describe("docs/09_sequences.md is read as the founder wrote it", () => {
  it("five emails, subjects, the role-based line, fallback lines, segment swaps, and the signature block", () => {
    expect([...templates.emails.keys()]).toEqual([1, 2, 3, 4, 5]);
    const e1 = templates.emails.get(1)!;
    expect(e1.subject_a).toBe("written security plan at {{firm_short}}?");
    expect(e1.subject_b).toBe("quick question about client data");
    expect(e1.roleLine).toBe("Quick question for whoever looks after IT and client data at {{firm}}:");
    expect(templates.emails.get(4)!.subject_a).toBe("helping a few firms in {{region}} first");
    // Notes after {{signature}} ("Sends only when checklist_ready ...") are not copy.
    expect(templates.emails.get(3)!.paragraphs.join(" ")).not.toMatch(/Sends only when/);
    expect(Object.keys(templates.fallbackLines).sort()).toEqual(["bookkeeper", "cpa", "payroll", "tax_preparer"]);
    expect(templates.segments.bookkeeper).toEqual({ email3Subject: "one-page checklist for bookkeeping firms", notes: "emphasize remote access and bank feeds" });
    expect(templates.signature).toEqual(["{{sender_name}}", "{{sender_title}}, {{company}}", "{{website}}", "", "{{opt_out_line}}", "{{physical_address}}"]);
  });

  it("refuses a file with an unknown merge field or an email without {{signature}}", () => {
    const md = (e1: string) =>
      [`## Fallback personal lines\n- cpa: "x."`, `## Email 1\nSubject A: a\nSubject B: b\n\n${e1}`, ...[2, 3, 4, 5].map((n) => `## Email ${n}\nText.\n\n{{signature}}`), `## Signature block\n{{sender_name}}`].join("\n\n");
    expect(() => parseTemplates(md("{{personal_line}}\n\n{{signature}}"))).not.toThrow();
    expect(() => parseTemplates(md("{{personal_line}} {{favorite_color}}\n\n{{signature}}"))).toThrow(/unknown merge field \{\{favorite_color\}\}/);
    expect(() => parseTemplates(md("{{personal_line}}"))).toThrow(/email 1 must end with a \{\{signature\}\} line/);
  });
});

describe("merge fields", () => {
  it("firm_short strips legal suffixes only", () => {
    expect(firmShort("Smith & Jones, LLC")).toBe("Smith & Jones");
    expect(firmShort("Maple Street CPAs, P.C.")).toBe("Maple Street CPAs");
    expect(firmShort("Acme Tax Inc.")).toBe("Acme Tax");
    expect(firmShort("Doe Accounting PLLC")).toBe("Doe Accounting");
    expect(firmShort("Inc Tax Services")).toBe("Inc Tax Services");
  });

  it("settings fields are filled from docs/01 when shown; an empty setting stays a visible placeholder", () => {
    expect(renderSettings("rate: {{offer}} at {{booking_link}} for {{region}} firms by {{company}}", READY_OFFER)).toBe(
      "rate: half off the first three months at https://cal.example.com/clearpath/15min for Columbus-area firms by ClearPath IT",
    );
    expect(renderSettings("rate: {{offer}}", offer)).toBe("rate: {{offer}}");
  });

  it("the signature block follows docs/09 and drops lines whose fields are all empty", () => {
    expect(renderSignature(templates.signature, READY_OFFER)).toEqual([
      "Mikaila Brown",
      "Founder, ClearPath IT",
      "https://www.clearpathsecure.com",
      "",
      READY_OFFER.opt_out_line,
      READY_OFFER.physical_address,
    ]);
    expect(renderSignature(templates.signature, { ...READY_OFFER, opt_out_line: "", physical_address: "" })).toEqual(["Mikaila Brown", "Founder, ClearPath IT", "https://www.clearpathsecure.com"]);
  });
});

describe("assembly and greeting", () => {
  it("no named contact: email 1 opens with the role-based line; emails 2-5 have no greeting", () => {
    const emails = build(generic());
    expect(emails[0]!.body.split("\n")[0]).toBe("Quick question for whoever looks after IT and client data at Smith Tax Services:");
    expect(emails[0]!.body).toContain(GOOD_LINE);
    for (const e of emails.slice(1)) expect(e.body).not.toMatch(/^(hi|hello|dear)\b/i);
    expect(emails[0]!.personal_line).toEqual({ text: GOOD_LINE, source: "model" });
    expect([...emails[0]!.grounding].sort()).toEqual(["firm_name", "services"]);
  });

  it('named contact tied to the address: "Hi Jane," and no role-based line', () => {
    const emails = build(strongDossier(), GOOD_LINE, "model", "Jane");
    expect(emails[0]!.body.startsWith("Hi Jane,\n\n")).toBe(true);
    expect(emails[0]!.body).not.toMatch(/Quick question for whoever/);
    for (const e of emails.slice(1)) expect(e.body).not.toMatch(/^hi\b/i);
  });

  it("the approved sentence comes verbatim from a VERIFIED docs/02 line for the segment", () => {
    const text = (t: FirmType) => build(ofType(t))[1]!.body;
    expect(text("cpa")).toContain(approved.find((a) => a.id === "insurers_ask_at_renewal")!.text);
    expect(text("tax_preparer")).toContain(approved.find((a) => a.id === "irs_pub_4557_wisp")!.text);
    expect(text("bookkeeper")).toContain(approved.find((a) => a.id === "rule_requirements")!.text);
    expect(text("payroll")).toContain(approved.find((a) => a.id === "rule_requirements")!.text);
    for (const t of FIRM_TYPES) expect(build(ofType(t))[1]!.body).not.toContain("{{approved_sentence}}");
  });

  it("segment swaps pick email 3's subject by primary type; other types use the cpa row", () => {
    const subject = (t: FirmType) => build(ofType(t))[2]!.subject_a;
    expect(subject("cpa")).toBe("one-page checklist for Smith Tax Services");
    expect(subject("tax_preparer")).toBe("one-page checklist for tax preparers");
    expect(subject("bookkeeper")).toBe("one-page checklist for bookkeeping firms");
    expect(subject("payroll")).toBe("one-page checklist for payroll firms");
    expect(subject("collections")).toBe("one-page checklist for Smith Tax Services");
  });

  it("the model's subject pick goes first; both stay for A/B", () => {
    const d = generic();
    const e1 = assembleEmails({ dossier: d, templates, style, approved, personalLine: { text: GOOD_LINE, source: "model" }, firstName: null, subjectChoice: "B", values: values(d) })[0]!;
    expect([e1.subject_a, e1.subject_b]).toEqual(["quick question about client data", "written security plan at Smith Tax Services?"]);
  });
});

describe("validators on the assembled sequence", () => {
  it("every segment, named or not, with the model line or the fallback: no validator errors", () => {
    for (const t of FIRM_TYPES) {
      for (const [d, first] of [
        [ofType(t), null],
        [ofType(t, strongDossier()), "Jane"],
      ] as const) {
        const fb = templates.fallbackLines[t] ?? templates.fallbackLines.cpa!;
        for (const [line, source] of [
          [GOOD_LINE, "model"],
          [fb, "fallback"],
        ] as const) {
          const s: Sequence = { lead_id: "L1", tier: "B", persona: "p", angle: style.firm_type_angles[t][0]!, emails: build(d, line, source, first) };
          expect(errorsOf(s, d), `${t} ${first ?? "role line"} ${source}`).toEqual([]);
        }
      }
    }
  });

  it("relaxed word limits from docs/03, email 5 by words", () => {
    expect(style.word_limits).toEqual({ "1": 130, "2": 140, "3": 100, "4": 130, "5": 75 });
    const d = generic();
    const s = seqOf(d);
    s.emails[4] = { ...s.emails[4]!, body: `${"word ".repeat(76).trim()}.` };
    expect(errorsOf(s, d).map((i) => [i.email, i.code])).toContainEqual([5, "word_count"]);
  });

  it("allows bullet lists in email 2: each bullet is its own item", () => {
    expect(bodySentences("Intro:\n- A written plan\n- One named person\nIs that close?")).toEqual(["Intro:", "A written plan", "One named person", "Is that close?"]);
    expect(errorsOf(seqOf(generic()), generic()).filter((i) => i.email === 2)).toEqual([]);
  });

  it("keeps one question mark per email", () => {
    const d = generic();
    const s = seqOf(d);
    s.emails[2] = { ...s.emails[2]!, body: `${s.emails[2]!.body} Does that help?` };
    expect(errorsOf(s, d).map((i) => [i.email, i.code])).toContainEqual([3, "too_many_questions"]);
  });

  it("subject words: the firm name (full or short) and the region do not count", () => {
    const d = generic({ firm_name: ev("Smith Tax and Accounting Services of Ohio, LLC", "Smith Tax and Accounting Services of Ohio, LLC") });
    const wide = { ...READY_OFFER, region: "Greater Columbus Metro-area" };
    const s = seqOf(d);
    expect(errorsOf(s, d, wide)).toEqual([]);
    s.emails[3] = { ...s.emails[3]!, subject_a: "helping a small number of firms in {{region}} first" };
    expect(errorsOf(s, d, wide).map((i) => i.code)).toContain("subject_length");
  });

  it("the only allowed link is booking_link; proof and DNS remarks stay blocked", () => {
    const d = generic();
    const s = seqOf(d);
    s.emails[3] = { ...s.emails[3]!, body: `${s.emails[3]!.body} See https://other.example.com.` };
    s.emails[1] = { ...s.emails[1]!, body: `${s.emails[1]!.body} Our clients trust us.` };
    s.emails[2] = { ...s.emails[2]!, body: `${s.emails[2]!.body} Your DMARC record is set to none.` };
    expect(errorsOf(s, d).map((i) => i.code)).toEqual(expect.arrayContaining(["link_not_allowed", "unapproved_proof", "dns_not_enabled"]));
  });

  it("empty docs/01 merge settings block export, not the text; the preview shows the placeholder", () => {
    const d = generic();
    const s = seqOf(d);
    expect(errorsOf(s, d, offer)).toEqual([]);
    const blockers = exportBlockers(offer, s).join("\n");
    expect(blockers).toMatch(/founding_client_offer \(offer\), booking_link, region/);
    expect(blockers).toMatch(/opt_out_line, physical_address/);
    expect(blockers).toMatch(/checklist_ready is false/);
    expect(exportBlockers(READY_OFFER, s)).toEqual([]);
    expect(renderEmail(s.emails[3]!.body, offer, renderSignature(templates.signature, offer))).toContain("{{booking_link}}");
  });

  it("a name is never used unless the address is tied to that person", () => {
    const d = generic();
    const s = seqOf(d);
    s.emails[0] = { ...s.emails[0]!, body: s.emails[0]!.body.replace(/^[^\n]*/, "Hi Jane,") };
    expect(errorsOf(s, d).map((i) => i.code)).toContain("greeting_contact_mismatch");
  });

  it("no firm name found: email 1 still names the firm through the role line fallback, never a generic template", () => {
    const d = generic({ firm_name: NOT_FOUND });
    const s: Sequence = { lead_id: "L1", tier: "C", persona: "p", angle: style.firm_type_angles.tax_preparer[0]!, emails: build(d, templates.fallbackLines.tax_preparer!, "fallback") };
    expect(errorsOf(s, d).map((i) => i.code)).toContain("generic_email_1");
  });
});

describe("personal line checks (code)", () => {
  const d = strongDossier();
  const check = (line: string) => validatePersonalLine(line, { dossier: d, values: values(d), style, evidence });

  it("accepts one plain sentence with one or two verified values", () => {
    expect(check(GOOD_LINE)).toEqual([]);
    expect(check("Payroll services put a lot of client bank details in your hands.")).toEqual([]);
    expect(check("A tax practice in Columbus holds a lot of client financial data.")).toEqual([]);
  });

  it.each([
    ["Does Smith Tax Services keep client data safe?", /question/],
    [`${GOOD_LINE} It is busy season.`, /one sentence/],
    [`Smith Tax Services handles individual tax returns ${"and more ".repeat(12)}for clients.`, /words \(max 30\)/],
    ["Smith Tax Services handles individual tax returns and payroll services in Columbus.", /uses 4 values/],
    ["Firms like yours handle a lot of client data.", /uses none of the verified values/],
    ["Smith Tax Services uses Drake for individual tax returns.", /uses software_mentioned/],
    ["Smith Tax Services, with a team of six, handles individual tax returns.", /size_signal/],
    ["Smith Tax Services falls under the FTC Safeguards Rule.", /regulatory/],
    ["Insurers now look closely at firms like Smith Tax Services.", /insurers/],
    ["Smith Tax Services has an impressive reputation in Columbus.", /evaluates/],
    ["Smith Tax Services does not have a written security plan.", /lacks a plan|regulatory/],
    ["Jane at Smith Tax Services handles individual tax returns.", /names a person/],
    ["Smith Tax Services has been in Columbus since 2004.", /number/],
    ["Smith Tax Services is a firm we work with in Columbus.", /proof/],
    ["The DMARC record for Smith Tax Services is missing.", /DNS/],
  ])("rejects: %s", (line, problem) => {
    expect(check(line).join("; ")).toMatch(problem);
  });
});

describe("generateSequence: one small call, repaired to the fallback line when needed", () => {
  it("tier B: one personal_line call; the model's line is used and its subject pick goes first", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE, subject: "B" }]));
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g).toMatchObject({ status: "passed", modelCalls: 1, personalLine: { line: { text: GOOD_LINE, source: "model" }, note: null } });
    expect(create).toHaveBeenCalledTimes(1);
    const p = create.mock.calls[0]![0];
    expect(p.max_tokens).toBe(200);
    expect(JSON.stringify(p.messages)).not.toMatch(/evidence_quote|evidence_url|jane@|Jane Smith/);
    expect(g.sequence!.emails[0]!.subject_a).toBe("quick question about client data");
    expect(db.select().from(runs).all().map((r) => r.callType)).toEqual(["personal_line"]);
  });

  it("tier C: the docs/09 fallback line for the type, no model call", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db);
    const g = await generateSequence("L1", generic(), "C", deps);
    expect(create).not.toHaveBeenCalled();
    expect(g).toMatchObject({ status: "passed", modelCalls: 0, personalLine: { line: { text: templates.fallbackLines.tax_preparer, source: "fallback" } } });
  });

  it.each([
    ["a line that fails the checks", scripted([{ personal_line: "Smith Tax Services has an impressive reputation." }]), /did not pass the checks \(evaluates or hypes/],
    ["an unreadable answer", scripted([{ line: "wrong field" }]), /could not be read/],
    ["an API error", () => Object.assign(new Error("bad request"), { status: 400 }), /the model was not used/],
  ])("%s: fallback line, still passed, with a plain note (never an error)", async (_label, responder, note) => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db, responder);
    const g = await generateSequence("L1", generic(), "A", deps);
    expect(g.status).toBe("passed");
    expect(g.personalLine!.line).toEqual({ text: templates.fallbackLines.tax_preparer, source: "fallback" });
    expect(g.personalLine!.note).toMatch(note);
  });

  it("the monthly spend cap: fallback line, no call, still passed", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }]), {}, 0);
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(create).not.toHaveBeenCalled();
    expect(g.status).toBe("passed");
    expect(g.personalLine!.note).toMatch(/model was not used/);
  });

  it("a gated lead gets no sequence until approved", async () => {
    const d = generic({ gate: { status: "out_of_icp", reasons: ["staff count 85 is above 60"] } });
    const { deps } = testWriteDeps(db);
    expect((await generateSequence("L1", d, "B", deps)).status).toBe("no_sequence");
  });
});

describe("approval, edits, judge, rewrite", () => {
  const ready = (over: Partial<WriteDeps> = {}) => ({ offer: READY_OFFER, ...over });

  it("a passed sequence is approved without any judge call; an older one never over a newer one", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }]), ready());
    const older = await generateSequence("L1", generic(), "B", deps);
    const newer = await generateSequence("L1", generic(), "B", deps);
    expect(() => approveSequence(db, older.sequenceId!)).toThrow(/newest/);
    approveSequence(db, newer.sequenceId!);
    expect(db.select().from(sequences).where(eq(sequences.id, newer.sequenceId!)).get()!.status).toBe("approved");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("a hand edit keeps the docs/09 copy allowed, needs the judge, and approval then works", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }]), ready());
    const g = await generateSequence("L1", generic(), "B", deps);
    const e2 = g.sequence!.emails[1]!;
    const edited = saveEdits(db, g.sequenceId!, [{ n: 2, body: e2.body.replace("Here's something", "Here is something") }], deps);
    expect(edited.validation.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(edited).toMatchObject({ judgeRequired: true, status: "blocked" });
    const judged = await runJudge(db, g.sequenceId!, deps);
    expect(judged.status).toBe("passed");
    approveSequence(db, g.sequenceId!);
  });

  it("a hand-edited regulatory sentence outside docs/02 and the template is caught", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }]), ready());
    const g = await generateSequence("L1", generic(), "B", deps);
    const e2 = g.sequence!.emails[1]!;
    const r = checkEdits(db, g.sequenceId!, [{ n: 2, body: `${e2.body} The FTC requires a plan by next year.` }], deps);
    expect(r.validation.issues.map((i) => i.code)).toContain("unapproved_regulatory_sentence");
  });

  it("rewrite: only email 1's personal line, one call; other emails are refused", async () => {
    saveLead("L1", generic());
    const other = "Payroll services put a lot of client bank details in your hands.";
    const { deps, create } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }, { personal_line: other }]), ready());
    const g = await generateSequence("L1", generic(), "B", deps);
    const r = await rewriteOne(db, g.sequenceId!, 1, deps);
    expect(r.sequence.emails[0]!.body).toContain(other);
    expect(create).toHaveBeenCalledTimes(2);
    await expect(rewriteOne(db, g.sequenceId!, 2, deps)).rejects.toThrow(/only email 1's personal line/);
  });

  it("buildSequence + validationContext reproduce a stored sequence", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db, scripted([{ personal_line: GOOD_LINE }]), ready());
    const g = await generateSequence("L1", generic(), "B", deps);
    const again = buildSequence("L1", generic(), "B", deps, g.sequence!.emails[0]!.personal_line!, null, null);
    expect(again.emails.slice(1)).toEqual(g.sequence!.emails.slice(1));
    expect(validateSequence(again, validationContext(generic(), deps)).pass).toBe(true);
  });
});
