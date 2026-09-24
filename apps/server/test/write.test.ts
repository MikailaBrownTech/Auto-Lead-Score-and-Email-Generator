import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_TOOL_NAME, WRITER_TOOL_NAME, type Dossier } from "@clearpath/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { runs, sequences } from "../src/db/schema";
import { loadEvidence, loadOffer, loadStyle, loadWriterFacts } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { createLlmClient } from "../src/llm/client";
import { SpendGate } from "../src/llm/spend-gate";
import { unverifiedRegulatoryNumbers, validateSequence } from "../src/validators/email";
import { ApprovalBlockedError, approveSequence, generateSequence, type WriteDeps } from "../src/write/generate";
import { loadJudgeSystemPrompt, loadWriterSystemPrompt } from "../src/write/prompt";
import { buildWriterInput, dnsObservation } from "../src/write/writer-input";
import { dnsEv, ev, strongDossier } from "./fixtures/dossiers";
import { fakeApi, testPrices, TEST_MODEL, userText } from "./fixtures/fakeapi";

const style = loadStyle();
const offer = loadOffer();
const evidence = loadEvidence();
const facts = loadWriterFacts();
const templates = loadTemplates();

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

const GOOD_DRAFT = {
  persona: "Solo or small tax preparer",
  angle: "irs_pub_4557_wisp",
  emails: [
    {
      n: 1,
      subject_a: "plan for Smith Tax Services",
      subject_b: "question about client returns",
      body: "I noticed Smith Tax Services prepares individual tax returns. Tax preparers are covered by the FTC Safeguards Rule, which asks for a written information security program. Is yours written down today?",
      grounding: ["firm_name", "services"],
    },
    {
      n: 2,
      subject_a: null,
      subject_b: null,
      body: "IRS Publication 4557 says tax professionals need a written information security plan. For a team of six sharing client files, it mostly means writing down who can open what. Would a short outline help?",
      grounding: ["size_signal"],
    },
  ],
};

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
    ...over,
  };
  return { deps: d, ...f };
}

/** Writer answers for "write" calls, judge answers for "judge" calls (by tool name). */
function scripted(drafts: unknown[], judgment: unknown = CLEAN_JUDGMENT) {
  let w = 0;
  return (p: Anthropic.MessageCreateParamsNonStreaming, i: number) => {
    const tool = (p.tools![0] as Anthropic.Tool).name;
    return toolMessage(tool, tool === WRITER_TOOL_NAME ? drafts[Math.min(w++, drafts.length - 1)] : judgment, i);
  };
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("writer input: values only", () => {
  it("contains no evidence quotes, no URLs, no email addresses, no people, no dollar or penalty facts", () => {
    const d = strongDossier();
    const input = buildWriterInput(d, offer, evidence);
    const json = JSON.stringify(input.prospect_facts);
    for (const quote of ["Jane Smith, EA, Owner", "Serving Columbus, Ohio since 2004", "our team of six", "Call (614) 555-0100"]) expect(json).not.toContain(quote);
    expect(json).not.toMatch(/https?:\/\/|@|\$\s?\d|penalt|Jane/i);
    expect(input.prospect_facts).toMatchObject({ firm_name: "Smith Tax Services", services: ["Individual tax returns", "Payroll services"], size_signal: { staff_count: 6 } });
  });

  it("drops values with personal details (the firm's own name is exempt)", () => {
    const d = strongDossier({
      firm_name: ev("Godfrey & Sons CPAs", "Godfrey & Sons CPAs"),
      services: { value: ["Tax returns", "Help for divorced clients"], evidence: [{ item: "Tax returns", evidence_url: "https://smithtax.example/" }, { item: "Help for divorced clients", evidence_url: "https://smithtax.example/" }] },
    });
    const input = buildWriterInput(d, offer, evidence);
    expect(input.prospect_facts).toMatchObject({ firm_name: "Godfrey & Sons CPAs", services: ["Tax returns"] });
    expect(input.filtered.join()).toMatch(/divorced/);
  });

  it("DNS observation: off by default; when on, only with MX and an evidenced DMARC finding; hedged", () => {
    expect(offer.include_dns_observation).toBe(false);
    const on = { ...offer, include_dns_observation: true };
    const d = strongDossier();
    expect(dnsObservation(d, offer)).toBeNull();
    expect(dnsObservation(d, on)).toBe("I noticed your domain does not publish a DMARC record.");
    const monitoring = strongDossier({ dns: { ...d.dns, dmarc_present: dnsEv(true), dmarc_policy: dnsEv("none" as const) } });
    expect(dnsObservation(monitoring, on)).toBe("I noticed your domain publishes a DMARC record set to monitoring only.");
    const noMx = strongDossier({ dns: { ...d.dns, no_domain_email: dnsEv(true, "smithtax.example", "MX") } });
    expect(dnsObservation(noMx, on)).toBeNull();
    expect(buildWriterInput(d, offer, evidence).prospect_facts.dns_observation).toBeUndefined();
  });
});

describe("prompts", () => {
  it("writer system prompt: docs read at runtime, VERIFIED facts only, no penalty figures, no lead content", () => {
    const p = loadWriterSystemPrompt({ offer, facts });
    expect(p).toContain("# Email style guide");
    expect(p).toContain("IRS Publication 4557");
    expect(p).toContain("PERSONA: CPA firm managing partner");
    expect(p).not.toMatch(/\$50,000|civil penalty/i);
    expect(p).not.toMatch(/\{\{[A-Z_]+\}\}|clearpath:style/);
    expect(p).not.toContain("Smith Tax Services");
  });
});

describe("tier and gate gating", () => {
  it("Tier C: five template emails, zero writer or judge calls", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "C", d);
    expect(create).not.toHaveBeenCalled();
    expect(r.sequence!.emails.every((e) => e.template)).toBe(true);
    expect(r).toMatchObject({ status: "passed", writerCalls: 0, judgeCalls: 0, judge: null });
  });

  it("needs_review and out_of_icp: no sequence and no calls until the founder approves the gate", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    for (const status of ["needs_review", "out_of_icp"] as const) {
      const gated = strongDossier({ gate: { status, reasons: ["test"] } });
      const r = await generateSequence("L1", gated, "A", d);
      expect(r).toMatchObject({ status: "no_sequence", sequence: null });
    }
    expect(create).not.toHaveBeenCalled();
    const approved = await generateSequence("L1", strongDossier({ gate: { status: "needs_review", reasons: ["test"] } }), "B", d, { gateApproved: true });
    expect(approved.status).toBe("passed");
  });
});

describe("Tier B: custom emails 1-2, templates 3-5, judged", () => {
  it("writes, validates, judges, and passes; runs logs write and judge with max_tokens per call type", async () => {
    const { deps: d, create } = deps(scripted([GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r.status).toBe("passed");
    expect(r.validation!.pass).toBe(true);
    expect(r.sequence!.emails.map((e) => e.template)).toEqual([false, false, true, true, true]);
    // The code adds the greeting (the decision maker's own address: "Hi Jane,").
    expect(r.sequence!.emails[0]!.body.startsWith("Hi Jane,\nI noticed Smith Tax Services")).toBe(true);
    expect(db.select().from(runs).all().map((x) => [x.callType, x.status])).toEqual([["write", "ok"], ["judge", "ok"]]);

    const writeParams = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(writeParams.max_tokens).toBe(2500);
    expect(writeParams.thinking).toEqual({ type: "disabled" });
    expect(writeParams.tool_choice).toEqual({ type: "tool", name: WRITER_TOOL_NAME });
    const system = writeParams.system as Anthropic.TextBlockParam[];
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
    const user = userText(writeParams);
    expect(user).toContain("<prospect_facts");
    expect(user).not.toMatch(/evidence_quote|evidence_url|https?:\/\/smithtax|jane@/);
    const judgeParams = create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(judgeParams.max_tokens).toBe(800);
    expect(judgeParams.tool_choice).toEqual({ type: "tool", name: JUDGE_TOOL_NAME });
    // The judge sees only the custom emails, never the templates.
    expect(userText(judgeParams)).not.toContain("Want me to send it over?");
  });

  it("a generic inbox is never greeted by name", async () => {
    const { deps: d } = deps(scripted([GOOD_DRAFT]));
    const generic = strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: "Jane Smith" }, "info@smithtax.example"), public_email_kind: "generic_inbox" });
    const r = await generateSequence("L1", generic, "B", d);
    for (const e of r.sequence!.emails) expect(e.body.startsWith("Hi,\n")).toBe(true);
    expect(r.status).toBe("passed");
  });

  it("validator failure gets exactly one rewrite; still failing means blocked and approval refused", async () => {
    const bad = { ...GOOD_DRAFT, emails: [{ ...GOOD_DRAFT.emails[0]!, body: "Your firm does not have a WISP! We guarantee compliance." }, GOOD_DRAFT.emails[1]!] };
    const { deps: d, create } = deps(scripted([bad, bad]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r.writerCalls).toBe(2);
    expect(create).toHaveBeenCalledTimes(3); // write, rewrite, judge
    const rewrite = userText(create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming);
    expect(rewrite).toContain("Your previous draft failed these checks");
    expect(rewrite).toMatch(/exclamation mark/);
    expect(r.status).toBe("blocked");
    expect(() => approveSequence(db, r.sequenceId!)).toThrow(ApprovalBlockedError);
  });

  it("counts facts the text uses even when the writer does not list them (city + service = two details)", async () => {
    const stacked = { ...GOOD_DRAFT, emails: [{ ...GOOD_DRAFT.emails[0]!, body: "I noticed Smith Tax Services prepares individual tax returns for clients in Columbus. Is a written plan in place today?", grounding: ["firm_name"] }, GOOD_DRAFT.emails[1]!] };
    const { deps: d, create } = deps(scripted([stacked, stacked]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r.sequence!.emails[0]!.grounding).toEqual(expect.arrayContaining(["firm_name", "location", "services"]));
    expect(r.validation!.issues.map((i) => i.code)).toContain("too_many_details");
    expect(userText(create.mock.calls[1]![0] as Anthropic.MessageCreateParamsNonStreaming)).toMatch(/2 personal details/);
    expect(r.status).toBe("blocked");
  });

  it("a rewrite that fixes the problems passes", async () => {
    const bad = { ...GOOD_DRAFT, emails: [{ ...GOOD_DRAFT.emails[0]!, body: "Quick question for you!" }, GOOD_DRAFT.emails[1]!] };
    const { deps: d } = deps(scripted([bad, GOOD_DRAFT]));
    const r = await generateSequence("L1", strongDossier(), "B", d);
    expect(r).toMatchObject({ status: "passed", writerCalls: 2, judgeCalls: 1 });
  });

  it("judge findings block approval; a clean sequence can be approved once", async () => {
    const claim = { unsupported_claims: [{ email: 2, claim: "team of six sharing client files", reason: "not_in_prospect_facts" }] };
    const blocked = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], claim)).deps);
    expect(blocked).toMatchObject({ status: "blocked", reason: "judge listed unsupported claims" });
    expect(() => approveSequence(db, blocked.sequenceId!)).toThrow(/blocked/);

    const clean = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT])).deps);
    approveSequence(db, clean.sequenceId!);
    expect(db.select().from(sequences).all().find((s) => s.id === clean.sequenceId)!.status).toBe("approved");
    // An older sequence can never be approved over a newer one.
    expect(() => approveSequence(db, blocked.sequenceId!)).toThrow(/newest/);
  });

  it("Tier A: all five emails custom", async () => {
    const five = {
      ...GOOD_DRAFT,
      emails: [
        ...GOOD_DRAFT.emails,
        { n: 3, subject_a: null, subject_b: null, body: "I have a one-page checklist of what the Safeguards Rule asks for, in plain language. Want me to send it over?", grounding: [] },
        { n: 4, subject_a: null, subject_b: null, body: "In short, the rule asks for a Qualified Individual, a written risk assessment, access controls, encryption, multi-factor authentication, and an incident response plan. Happy to walk through any of it: https://www.clearpathsecure.com/contact", grounding: [] },
        { n: 5, subject_a: null, subject_b: null, body: "I will assume the timing is not right and stop here. If a written plan comes up later, just reply.", grounding: [] },
      ],
    };
    const r = await generateSequence("L1", strongDossier(), "A", deps(scripted([five])).deps);
    expect(r.sequence!.emails.every((e) => !e.template)).toBe(true);
    expect(r.status).toBe("passed");
  });
});

describe("validators: DNS remarks and regulatory numbers", () => {
  const seqWith = (body: string, grounding: string[] = []) => ({
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
      template: n >= 3,
    })),
  });
  const codes = (d: Dossier, body: string, grounding: string[] = [], o = offer) =>
    validateSequence(seqWith(body, grounding) as never, { style, offer: o, dossier: d, verifiedFacts: facts }).issues.filter((i) => i.email === 1).map((i) => i.code);

  it("blocks DNS remarks while include_dns_observation is off", () => {
    expect(codes(strongDossier(), "I noticed your domain does not publish a DMARC record. Is that on purpose?", ["dns_observation"])).toContain("dns_not_enabled");
  });

  it("when on: needs grounding and evidence, and never alarm words", () => {
    const on = { ...offer, include_dns_observation: true };
    const d = strongDossier();
    expect(codes(d, "I noticed your domain does not publish a DMARC record. Is that on purpose?", ["dns_observation"], on)).toEqual([]);
    expect(codes(d, "I noticed your domain does not publish a DMARC record. Is that on purpose?", [], on)).toContain("dns_not_grounded");
    expect(codes(d, "Your domain has no DMARC record, so it is vulnerable. Is that on purpose?", ["dns_observation"], on)).toContain("dns_alarm");
    const noMx = strongDossier({ dns: { ...d.dns, no_domain_email: dnsEv(true, "smithtax.example", "MX") } });
    expect(codes(noMx, "I noticed your domain does not publish a DMARC record. Is that on purpose?", ["dns_observation"], on)).toContain("dns_not_evidenced");
  });

  it("numbers in regulatory sentences must come from the VERIFIED facts", () => {
    expect(unverifiedRegulatoryNumbers("The FTC Safeguards Rule requires notice within 45 days.", facts)).toHaveLength(1);
    expect(unverifiedRegulatoryNumbers("The rule requires notifying the FTC within 30 days of discovery. IRS Publication 4557 covers this.", facts)).toEqual([]);
    expect(unverifiedRegulatoryNumbers("Here is what the rule asks for: 1. A Qualified Individual 2. Encryption", facts)).toEqual([]);
  });

  it("every template variant still passes with the regulatory-number check on", async () => {
    for (const primary of ["cpa", "tax_preparer", "bookkeeper", "payroll", "credit_counseling", "collections"] as const) {
      const d = strongDossier({
        firm_type: ev({ primary, secondary: [] }, "x"),
        target_industry_fit: { value: true, reason: "t", qualifying_type: primary },
      });
      const r = await generateSequence("L1", d, "C", deps(scripted([GOOD_DRAFT])).deps);
      expect(r.validation!.issues.filter((i) => i.severity === "error"), primary).toEqual([]);
    }
  });
});

describe("judge output handling", () => {
  it("accepts an array sent as a JSON string; an unreadable verdict blocks with its reason", async () => {
    const stringified = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], { unsupported_claims: "[]" })).deps);
    expect(stringified.status).toBe("passed");
    const broken = await generateSequence("L1", strongDossier(), "B", deps(scripted([GOOD_DRAFT], { verdict: "fine" })).deps);
    expect(broken.status).toBe("blocked");
    expect(broken.judge!.unsupported_claims[0]!.claim).toMatch(/^judge output could not be read: /);
  });
});
