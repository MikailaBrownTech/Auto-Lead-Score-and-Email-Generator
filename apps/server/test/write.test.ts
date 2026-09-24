import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_TOOL_NAME, WRITER_TOOL_NAME, type Dossier } from "@clearpath/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leads, runs, sequences } from "../src/db/schema";
import { loadApprovedSentences, loadEvidence, loadOffer, loadStyle, loadWriterFacts, usableApprovedSentences } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { createLlmClient } from "../src/llm/client";
import { SpendGate } from "../src/llm/spend-gate";
import { renderEmail, unapprovedSentences, unverifiedRegulatoryNumbers, validateSequence } from "../src/validators/email";
import { approveSequence, exportBlockers, generateSequence, type WriteDeps } from "../src/write/generate";
import { judgeMessage, loadJudgeSystemPrompt, loadPersonaHeadings, loadWriterSystemPrompt, writerMessage } from "../src/write/prompt";
import { dnsObservation, planSequence, verifiedValues } from "../src/write/writer-input";
import { dnsEv, ev, strongDossier } from "./fixtures/dossiers";
import { fakeApi, testPrices, TEST_MODEL, userText } from "./fixtures/fakeapi";

const style = loadStyle();
const offer = loadOffer();
const evidence = loadEvidence();
const facts = loadWriterFacts();
const templates = loadTemplates();
const approved = loadApprovedSentences().sentences;
const personas = loadPersonaHeadings();
const APPLIES = approved.find((s) => s.id === "applies_accounting_tax")!.text;
const IRS = approved.find((s) => s.id === "irs_pub_4557_wisp")!.text;

function toolMessage(name: string, input: unknown, i: number): Anthropic.Message {
  return {
    id: `msg_${i}`,
    type: "message",
    role: "assistant",
    model: TEST_MODEL,
    content: [{ type: "tool_use", id: `toolu_${i}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 400, cache_read_input_tokens: i > 0 ? 4000 : 0, cache_creation_input_tokens: i === 0 ? 4000 : 0 },
  } as unknown as Anthropic.Message;
}

type WriterEmail = { n: number; subject_a: string | null; subject_b: string | null; opening: string; closing: string };
const E1: WriterEmail = {
  n: 1,
  subject_a: "plan for Smith Tax Services",
  subject_b: "client data question",
  opening: "I noticed Smith Tax Services prepares individual tax returns for clients around Columbus.",
  closing: "Is a written security plan something you already keep on file?",
};
const E2: WriterEmail = {
  n: 2,
  subject_a: null,
  subject_b: null,
  opening: "Following up, since payroll services put client bank details in your hands too.",
  closing: "Would a short outline of what that plan covers be useful?",
};
const GOOD_DRAFT = { emails: [E1, E2] };
const draftWith = (e1: Partial<WriterEmail>, e2: Partial<WriterEmail> = {}) => ({ emails: [{ ...E1, ...e1 }, { ...E2, ...e2 }] });
const CLEAN_JUDGMENT = { unsupported_claims: [] };

let db: Db;
function deps(responder: Parameters<typeof fakeApi>[0], over: Partial<WriteDeps> = {}) {
  const f = fakeApi(responder);
  const now = () => new Date("2026-09-24T12:00:00Z");
  const llm = createLlmClient({ api: f.api, db, prices: testPrices, gate: new SpendGate(db, 5, now), leadTokenBudget: 1_000_000, backoff: { sleep: async () => undefined } });
  const d: WriteDeps = {
    db,
    llm,
    modelWrite: TEST_MODEL,
    writerSystem: loadWriterSystemPrompt({ offer, facts }),
    judgeSystem: loadJudgeSystemPrompt({ offer, facts }),
    style,
    offer,
    evidence,
    templates,
    facts,
    approved,
    personas,
    ...over,
  };
  return { deps: d, ...f };
}

/** Writer answers for writer calls, judge answers for judge calls (by tool name). */
function scripted(drafts: unknown[], judgment: unknown = CLEAN_JUDGMENT) {
  let w = 0;
  return (p: Anthropic.MessageCreateParamsNonStreaming, i: number) => {
    const tool = (p.tools![0] as Anthropic.Tool).name;
    return toolMessage(tool, tool === WRITER_TOOL_NAME ? drafts[Math.min(w++, drafts.length - 1)] : judgment, i);
  };
}

const plan = (d: Dossier, ns = [1, 2]) => planSequence(d, ns, { offer, evidence, style, approved, personas, greeting: "Hi Jane," });

beforeEach(() => {
  db = openDb(":memory:");
});

describe("constrained writer input (code chooses everything)", () => {
  it("one ranked detail per email: services naming the firm type first, then software, then staff size", () => {
    const p = plan(strongDossier(), [1, 2, 3, 4, 5]);
    expect(p.emails.map((e) => e.detail)).toEqual([
      { field: "services", value: "Individual tax returns" },
      { field: "services", value: "Payroll services" },
      null,
      null,
      null,
    ]);
    expect(p.context).toMatchObject({ firm_name: "Smith Tax Services", firm_type: "tax_preparer", location: { city: "Columbus", state: "OH" }, persona: "Solo or small tax preparer", angle: "irs_pub_4557_wisp" });
    const noServices = plan(strongDossier({ services: "NOT_FOUND", software_mentioned: "NOT_FOUND" }));
    expect(noServices.emails[0]!.detail).toEqual({ field: "size_signal", value: "a team of 6" });
  });

  it("slots get approved docs/02 sentences by email and firm type", () => {
    const tax = plan(strongDossier(), [1, 2, 3, 4, 5]);
    expect(tax.emails.map((e) => e.approved?.id ?? null)).toEqual(["applies_accounting_tax", "irs_pub_4557_wisp", null, "rule_requirements", null]);
    const cpa = plan(strongDossier({ target_industry_fit: { value: true, reason: "t", qualifying_type: "cpa" } }));
    expect(cpa.emails.map((e) => e.approved?.id)).toEqual(["applies_accounting_tax", "insurers_ask_at_renewal"]);
    const payroll = plan(strongDossier({ target_industry_fit: { value: true, reason: "t", qualifying_type: "payroll" } }));
    expect(payroll.emails.map((e) => e.approved?.id)).toEqual(["applies_non_bank", "rule_requirements"]);
  });

  it("the writer message has only the chosen values: no quotes, URLs, addresses, people, other details, or money", () => {
    const text = writerMessage(plan(strongDossier()), 5);
    expect(text).not.toMatch(/evidence_quote|https?:\/\/smithtax|@|Jane Smith|Drake|\$\s?\d|penalt/i);
    expect(text).toContain('"email_1": "Individual tax returns"');
    expect(text).toContain(APPLIES);
    expect(text).toContain("greeting (added by the code; do not write it): Hi Jane,");
  });

  it("personal-detail filter drops values before ranking (the firm's own name is exempt)", () => {
    const d = strongDossier({
      firm_name: ev("Godfrey & Sons CPAs", "Godfrey & Sons CPAs"),
      services: { value: ["Help for divorced clients", "Tax returns"], evidence: [{ item: "Help for divorced clients", evidence_url: "https://smithtax.example/" }, { item: "Tax returns", evidence_url: "https://smithtax.example/" }] },
    });
    const p = plan(d);
    expect(p.context.firm_name).toBe("Godfrey & Sons CPAs");
    expect(p.emails[0]!.detail).toEqual({ field: "services", value: "Tax returns" });
    expect(p.filtered.join()).toMatch(/divorced/);
  });

  it("DNS observation: off by default; when on, only with MX and an evidenced finding", () => {
    const on = { ...offer, include_dns_observation: true };
    const d = strongDossier();
    expect(dnsObservation(d, offer)).toBeNull();
    expect(dnsObservation(d, on)).toBe("I noticed your domain does not publish a DMARC record.");
    const noMx = strongDossier({ dns: { ...d.dns, no_domain_email: dnsEv(true, "smithtax.example", "MX") } });
    expect(dnsObservation(noMx, on)).toBeNull();
    expect(verifiedValues(d, offer, evidence).prospect_facts.dns_observation).toBeUndefined();
  });
});

describe("docs/02 approved sentences", () => {
  it("loads only sentences that restate a VERIFIED line, with no money or penalties", () => {
    expect(approved.map((s) => s.id)).toEqual(["applies_accounting_tax", "applies_non_bank", "irs_pub_4557_wisp", "insurers_ask_at_renewal", "rule_requirements"]);
    const md = [
      "- The rule applies to banks. [VERIFY]",
      "- Maximum civil penalty per violation: $50,000. VERIFIED",
      "```json clearpath:regulatory",
      JSON.stringify({
        approved_sentences: [
          { id: "unverified", text: "The rule applies to banks.", source: "The rule applies to banks", emails: [1], firm_types: ["any"] },
          { id: "money", text: "Fines reach $50,000.", source: "Maximum civil penalty", emails: [1], firm_types: ["any"] },
        ],
      }),
      "```",
    ].join("\n");
    expect(usableApprovedSentences(md)).toMatchObject({ sentences: [], excluded: [{ id: "unverified" }, { id: "money" }] });
  });
});

describe("tier and gate gating", () => {
  it("Tier C: five template emails, zero writer or judge calls", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "C", d);
    expect(create).not.toHaveBeenCalled();
    expect(r.sequence!.emails.every((e) => e.template)).toBe(true);
    expect(r).toMatchObject({ status: "passed", writerCalls: 0, judgeCalls: 0, judge: null, firstPassValid: null });
  });

  it("needs_review and out_of_icp: no sequence and no calls until the founder approves the gate", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    for (const status of ["needs_review", "out_of_icp"] as const) {
      const r = await generateSequence("L1", strongDossier({ gate: { status, reasons: ["test"] } }), "A", d);
      expect(r).toMatchObject({ status: "no_sequence", sequence: null });
    }
    expect(create).not.toHaveBeenCalled();
    const approvedGate = await generateSequence("L1", strongDossier({ gate: { status: "needs_review", reasons: ["test"] } }), "B", d, { gateApproved: true });
    expect(approvedGate.status).toBe("passed");
  });

  it("every template variant passes the validators; email 3 does not assess the firm", async () => {
    for (const t of ["cpa", "tax_preparer", "bookkeeper", "payroll", "credit_counseling", "collections"] as const) {
      const d = strongDossier({ firm_type: ev({ primary: t, secondary: [] }, "x"), target_industry_fit: { value: true, reason: "t", qualifying_type: t } });
      const r = await generateSequence("L1", d, "C", deps(scripted([GOOD_DRAFT])).deps);
      expect(r.validation!.issues.filter((i) => i.severity === "error"), t).toEqual([]);
    }
    expect(templates.get("email3.checklist")!.body).toContain("so you can check your firm against it");
    expect(templates.get("email3.checklist")!.body).not.toMatch(/stands/);
    expect(templates.get("email3.scorecard")!.body).not.toMatch(/stands/);
  });
});

describe("Tier B: writer emails 1-2 with code-inserted approved sentences", () => {
  it("assembles greeting + model opening + approved sentence (verbatim) + model closing, and passes", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r).toMatchObject({ status: "passed", firstPassValid: true, rewritesUsed: 0, writerCalls: 1, judgeCalls: 1 });
    expect(r.sequence!.emails[0]!.body).toBe(`Hi Jane,\n${E1.opening} ${APPLIES} ${E1.closing}`);
    expect(r.sequence!.emails[1]!.body).toBe(`Hi Jane,\n${E2.opening} ${IRS} ${E2.closing}`);
    expect(r.sequence!.emails.map((e) => e.template)).toEqual([false, false, true, true, true]);
    // The city is context, not a detail: email 1 uses services + location and still has one detail.
    expect(r.sequence!.emails[0]!.grounding).toEqual(expect.arrayContaining(["services", "location"]));
    expect(r.drafts[0]!.emails[0]!.inserted).toEqual([{ id: "applies_accounting_tax", text: APPLIES }]);
    expect(db.select().from(runs).all().map((x) => x.callType)).toEqual(["write", "judge"]);
    const writeParams = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(writeParams).toMatchObject({ max_tokens: 2500, thinking: { type: "disabled" }, tool_choice: { type: "tool", name: WRITER_TOOL_NAME } });
    expect((writeParams.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({ type: "ephemeral" });
    const judgeParams = create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(judgeParams).toMatchObject({ max_tokens: 800, tool_choice: { type: "tool", name: JUDGE_TOOL_NAME } });
    expect(userText(judgeParams)).toContain("approved_sentences (inserted by code");
  });

  it("a model-written regulatory sentence is rejected; one rewrite only; every draft is kept", async () => {
    const bad = draftWith({ closing: "Tax preparers must have a WISP under the rule. Do you have one?" });
    const { deps: d, create } = deps(scripted([bad, bad]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(create).toHaveBeenCalledTimes(3); // write, one rewrite, judge
    expect(r).toMatchObject({ status: "blocked", firstPassValid: false, rewritesUsed: 1 });
    expect(r.drafts).toHaveLength(2);
    expect(r.drafts[0]!.errors.map((i) => i.code)).toContain("unapproved_regulatory_sentence");
    expect(userText(create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming)).toContain("Your previous draft failed these checks");
  });

  it("a rewrite that fixes the problems passes", async () => {
    const { deps: d } = deps(scripted([draftWith({ opening: "That is a good sign for Smith Tax Services." }), GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r).toMatchObject({ status: "passed", firstPassValid: false, rewritesUsed: 1 });
  });

  it("judge findings block approval; JSON-string arrays are accepted; unreadable verdicts block", async () => {
    const claim = { unsupported_claims: [{ email: 2, claim: "client bank details", reason: "not_in_prospect_facts" }] };
    const blocked = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], claim)).deps);
    expect(blocked).toMatchObject({ status: "blocked", reason: "judge listed unsupported claims" });
    expect(() => approveSequence(db, blocked.sequenceId!, offer)).toThrow(/blocked/);
    const stringified = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], { unsupported_claims: "[]" })).deps);
    expect(stringified.status).toBe("passed");
    const broken = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], { verdict: "fine" })).deps);
    expect(broken.judge!.unsupported_claims[0]!.claim).toMatch(/^judge output could not be read: /);
  });
});

describe("approval and export blockers", () => {
  const saveLead = (d: Dossier) => db.insert(leads).values({ id: "L1", source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();

  it("generic inbox: needs_direct_contact blocks approval (content can pass) unless overridden", async () => {
    const generic = strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox" });
    saveLead(generic);
    const r = await generateSequence("L1", generic, "B", deps(scripted([GOOD_DRAFT])).deps);
    expect(r.status).toBe("passed");
    for (const e of r.sequence!.emails) expect(e.body.startsWith("Hi,\n")).toBe(true);
    expect(r.approvalBlockers.join()).toMatch(/^needs_direct_contact: info@smithtax\.example is a generic inbox/);
    expect(() => approveSequence(db, r.sequenceId!, offer)).toThrow(/needs_direct_contact/);
    approveSequence(db, r.sequenceId!, { ...offer, allow_without_direct_contact: true });
    expect(db.select().from(sequences).all().at(-1)!.status).toBe("approved");
  });

  it("an older sequence can never be approved over a newer one", async () => {
    saveLead(strongDossier());
    const older = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT])).deps);
    await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT])).deps);
    expect(() => approveSequence(db, older.sequenceId!, offer)).toThrow(/newest/);
  });

  it("export is blocked while checklist_ready is false, and while signature or footer settings are empty", () => {
    const seq = { lead_id: "L1", tier: "C" as const, persona: "p", angle: "a", emails: [] as never[] };
    const withEmail3 = { ...seq, emails: [{ n: 3 }] as never[] };
    expect(exportBlockers(strongDossier(), offer, withEmail3).join("\n")).toMatch(/checklist_ready is false/);
    expect(exportBlockers(strongDossier(), offer, seq).join("\n")).toMatch(/opt_out_line, physical_address/);
    const ready = { ...offer, checklist_ready: true, opt_out_line: "Reply no to stop.", physical_address: "1 Main St" };
    expect(exportBlockers(strongDossier(), ready, withEmail3)).toEqual([]);
  });
});

describe("validators: allowlist, insurers, quantifiers, questions, evaluations, company name, details", () => {
  const seqWith = (body: string, grounding: string[] = [], template = false) => ({
    lead_id: "L1",
    tier: "B" as const,
    persona: "p",
    angle: "irs_pub_4557_wisp",
    emails: [1, 2, 3, 4, 5].map((n) => ({
      n,
      send_day: style.send_days[n - 1]!,
      subject_a: n === 1 ? "written plan" : null,
      subject_b: n === 1 ? "client data" : null,
      body: n === 1 ? `Hi Jane,\n${body}` : "Hi Jane,\nShort note. Does that help?",
      grounding: n === 1 ? grounding : [],
      template: n >= 3 || template,
    })),
  });
  const codes = (body: string, grounding: string[] = [], o = offer, assigned: string | null = "services", template = false) =>
    validateSequence(seqWith(body, grounding, template) as never, {
      style,
      offer: o,
      dossier: strongDossier(),
      verifiedFacts: facts,
      approvedSentences: approved.map((s) => s.text),
      assignedDetails: { 1: assigned, 2: null },
    }).issues.filter((i) => i.email === 1 && i.severity === "error").map((i) => i.code);

  it("regulatory sentences only as approved docs/02 sentences, verbatim", () => {
    expect(codes(`${APPLIES} Is a written plan on file?`)).toEqual([]);
    expect(codes("The FTC Safeguards Rule covers firms like yours. Is a written plan on file?")).toContain("unapproved_regulatory_sentence");
    expect(codes("Tax preparers must keep a written plan. Is yours on file?")).toContain("unapproved_regulatory_sentence");
    expect(unapprovedSentences("Staying in compliance takes time.", [])).toEqual([{ sentence: "Staying in compliance takes time.", code: "unapproved_regulatory_sentence" }]);
    // Templates are fixed docs/09 text, checked by the other validators.
    expect(codes("The FTC Safeguards Rule covers many firms. Is a written plan on file?", [], offer, null, true)).toEqual([]);
  });

  it("insurer assertions need an approved sentence; insurer questions are fine", () => {
    expect(codes("Insurers are asking firms like yours for a written plan. Is yours on file?")).toContain("unapproved_insurer_claim");
    expect(codes("Has your insurer asked about a written security plan yet?")).toEqual([]);
  });

  it("universal quantifiers only inside approved sentences", () => {
    expect(codes("Every firm needs a written plan. Is yours on file?")).toContain("universal_quantifier");
    expect(codes("Firms like yours are generally covered. Is a plan on file?")).toContain("universal_quantifier");
  });

  it("one question per email at most", () => {
    expect(codes("Is a plan on file? Would a checklist help?")).toContain("too_many_questions");
  });

  it("evaluative phrases about the prospect are banned", () => {
    for (const phrase of ["That is a good sign.", "Maybe it is still on your to-do list.", "Firms are falling behind.", "You're behind on this.", "You are not compliant.", "Client data is at risk.", "Your files are exposed."]) {
      expect(codes(`${phrase} Is a plan on file?`), phrase).toContain("banned_phrase");
    }
  });

  it("the company name comes only from docs/01", () => {
    expect(codes("I run ClearPath Security, a small IT shop. Is a plan on file?")).toContain("company_name");
    expect(codes("I run ClearPath IT, a small IT shop. Is a plan on file?")).not.toContain("company_name");
  });

  it("city/state is free context; a detail other than the assigned one is rejected", () => {
    expect(codes("Noticed you prepare individual tax returns around Columbus. Is a plan on file?", ["services", "location"])).toEqual([]);
    expect(codes("Noticed you use Drake. Is a plan on file?", ["software_mentioned"])).toContain("unassigned_detail");
    expect(codes("Noticed your tax returns and Drake. Is a plan on file?", ["services", "software_mentioned"])).toContain("too_many_details");
  });

  it("DNS remarks: blocked while the setting is off; allowed hedged and evidenced when on", () => {
    expect(codes("I noticed your domain does not publish a DMARC record. Is that on purpose?", ["dns_observation"])).toContain("dns_not_enabled");
    const on = { ...offer, include_dns_observation: true };
    expect(codes("I noticed your domain does not publish a DMARC record. Is that on purpose?", ["dns_observation"], on)).toEqual([]);
  });

  it("numbers in regulatory sentences must come from the VERIFIED facts", () => {
    expect(unverifiedRegulatoryNumbers("The FTC Safeguards Rule requires notice within 45 days.", facts)).toHaveLength(1);
    expect(unverifiedRegulatoryNumbers("Here is what the rule asks for: 1. A Qualified Individual 2. Encryption", facts)).toEqual([]);
  });
});

describe("signature and prompts", () => {
  it("every email ends with sender name, title, company, website, then opt-out and address", () => {
    const full = { ...offer, opt_out_line: "Reply no and I will not email again.", physical_address: "1 Main St, Columbus, OH" };
    expect(renderEmail("Hi Jane,\nBody.", full)).toBe(
      "Hi Jane,\nBody.\n\nMikaila Brown\nFounder\nClearPath IT\nhttps://www.clearpathsecure.com\n\nReply no and I will not email again.\n1 Main St, Columbus, OH",
    );
  });

  it("writer system prompt: docs read at runtime; forbids regulatory writing; no penalty figures, no lead content", () => {
    const p = loadWriterSystemPrompt({ offer, facts });
    expect(p).toContain("# Email style guide");
    expect(p).toContain("Never write a regulatory or insurer statement yourself");
    expect(p).not.toMatch(/\$50,000|civil penalty/i);
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(p).not.toContain("Smith Tax Services");
    expect(judgeMessage(plan(strongDossier()), [])).toContain(APPLIES);
  });
});

describe("writer output tolerance", () => {
  it("ignores unknown extra keys in the writer's output, but still rejects missing fields", async () => {
    const extra = { emails: [{ ...E1, n_check: 1 }, E2] };
    expect((await generateSequence("L1", strongDossier(), "B", deps(scripted([extra])).deps)).status).toBe("passed");
    const missing = { emails: [{ n: 1, subject_a: "x", subject_b: "y" }, E2] };
    const r = await generateSequence("L1", strongDossier(), "B", deps(scripted([missing, missing])).deps);
    expect(r).toMatchObject({ rewritesUsed: 1 });
    expect(r.drafts[0]!.formatProblem).toMatch(/writer output invalid/);
    // Nothing usable from the model twice: the template emails are shown (never an empty result), and
    // the reason says so.
    expect(r.sequence!.emails.every((e) => e.template)).toBe(true);
    expect(r.reason).toMatch(/template emails are shown instead/);
  });
});
