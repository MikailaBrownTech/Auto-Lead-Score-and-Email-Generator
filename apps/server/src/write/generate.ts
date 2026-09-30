import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  isFound,
  JUDGE_TOOL_NAME,
  JudgeOutputSchema,
  SequenceSchema,
  type ApprovedSentence,
  type Dossier,
  type EvidenceConfig,
  type JudgeOutput,
  type OfferConfig,
  type RegulatoryFact,
  type Sequence,
  type SequenceEmail,
  type StyleConfig,
  type Tier,
} from "@clearpath/shared";
import type { SequenceStatus } from "../db/schema";
import type { EventsDb, SequencesDb } from "../db/supa-sequences";
import type { LeadsDb } from "../db/supa-leads";
import type { RunsDb } from "../db/supa-runs";
import type { TemplateSet } from "../docs/templates";
import { BudgetExceededError, lastRunId, type LlmClient } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { contactPlan } from "../scoring/contact";
import { contactWarning, type DirectContactOverride } from "../scoring/direct-contact";
import { validateSequence, type ValidationContext, type ValidationResult } from "../validators/email";
import { assembleEmails, leadSegment } from "./assemble";
import { emptySettingsUsed } from "./merge";
import { judgeMessage, judgeTool } from "./prompt";
import { verifiedValues } from "./values";
import { writerInput, writerType, writeSequenceEmails, type Draft } from "./writer";

export class ApprovalBlockedError extends Error {
  override name = "ApprovalBlockedError";
}

export interface WriteDeps {
  leadsDb: LeadsDb;
  sequencesDb: SequencesDb;
  eventsDb: EventsDb;
  runsDb: RunsDb;
  llm: LlmClient;
  /** Writer and judge model (MODEL_WRITE). The writer sees only the compact dossier values. */
  modelWrite: string;
  /** Writer system prompt for a lead: the example pair is rotated by lead id (prompt.examplesFor). */
  writerSystem: (leadId: string) => string;
  judgeSystem: string;
  style: StyleConfig;
  offer: OfferConfig;
  evidence: EvidenceConfig;
  /** docs/09_sequences.md: the tier C fixed copy and the signature block. */
  templates: TemplateSet;
  /** VERIFIED docs/02 facts (money/penalty facts removed); for the judge prompt. */
  facts: RegulatoryFact[];
  /** Usable docs/02 approved sentences (loadApprovedSentences). */
  approved: ApprovedSentence[];
  /** docs/08 "PERSONA:" headings. */
  personas: string[];
}

export interface GenerateResult {
  leadId: string;
  /** no_sequence: gated. blocked: validators or judge failed after the rewrite. passed: approvable. */
  status: "no_sequence" | SequenceStatus;
  reason: string;
  tier: Tier;
  sequence: Sequence | null;
  validation: ValidationResult | null;
  judge: JudgeOutput | null;
  /** Every writer draft (first, rewrite) with its errors; empty for tier C. */
  drafts: Draft[];
  /** True when the first draft had no validator errors (null: no writer call). */
  firstPassValid: boolean | null;
  writerCalls: number;
  judgeCalls: number;
  sequenceId: number | null;
  /** A lead without a named contact: a warning in plain words (never a blocker); null for a named contact. */
  contactWarning: string | null;
  /** Reasons export is refused (settings, footer, checklist_ready). */
  exportBlockers: string[];
}

/** The judge verdict as stored, tied to the exact content it judged. */
export interface StoredJudge {
  result: JudgeOutput;
  content_hash: string;
}

/** Emails that need the judge: model-written or hand-edited ones. The untouched docs/09 copy does not. */
export function judgedEmails(emails: SequenceEmail[]): SequenceEmail[] {
  return emails.filter((e) => !e.template || e.edited);
}

/** Hash of the subjects and bodies the judge must have seen for approval to count. */
export function judgedContentHash(emails: SequenceEmail[]): string {
  const material = JSON.stringify(judgedEmails(emails).map((e) => [e.n, e.subject_a, e.subject_b, e.body]));
  return crypto.createHash("sha256").update(material).digest("hex");
}

/** The plain reason a gated lead gets no sequence, with what to do about it. */
export function notWrittenReason(gate: Dossier["gate"]): string {
  const why = gate.reasons.length ? ` (${gate.reasons.join("; ")})` : "";
  if (gate.status === "out_of_icp") return `Not written: this lead is out of ICP${why}. Approve it with a reason to write anyway.`;
  if (gate.status === "needs_review") return `Not written: this lead needs review${why}. Approve it with a reason to write anyway.`;
  return "Not written.";
}

/** Keeps the outcome of a write attempt in the lead's log, so the lead page can say what happened. */
export function logWriteAttempt(eventsDb: EventsDb, leadId: string, detail: string): Promise<void> {
  return eventsDb.insert({ leadId, kind: "write_attempt", detail: detail.slice(0, 1000) });
}

/** Every lead the writer can write for gets all five emails from the model (the tier/template split is gone). */
export const ALL_EMAIL_NUMBERS = [1, 2, 3, 4, 5] as const;

/** First name for email 1: only when the public address is tied to that person, and never after a contact override. */
export function firstNameFor(d: Dossier, override: DirectContactOverride | null): string | null {
  return override ? null : contactPlan(d).greetFirstName;
}

/** Settings that refuse the whole export. A missing named contact is never one of them. */
export function exportBlockers(offer: OfferConfig, seq: Sequence | null): string[] {
  const out: string[] = [];
  const empty = (["sender_title", "company_name", "company_website", "opt_out_line", "physical_address"] as const).filter((k) => offer[k].trim() === "");
  if (empty.length > 0) out.push(`docs/01 settings empty: ${empty.join(", ")}`);
  const merge = new Set(["offer", "booking_link", "region", ...(seq ? seq.emails.flatMap((e) => emptySettingsUsed([e.body, e.subject_a ?? ""].join("\n"), offer)) : [])]);
  const missing = [...merge].filter((f) => (f === "offer" ? !offer.founding_client_offer?.trim() : f === "booking_link" ? !offer.booking_link.trim() : f === "region" ? !offer.region.trim() : true));
  if (missing.length > 0) out.push(`docs/01 merge settings empty: ${missing.map((f) => (f === "offer" ? "founding_client_offer (offer)" : f)).join(", ")}`);
  if (seq?.emails.some((e) => e.n === 3) && !offer.checklist_ready) {
    out.push("checklist_ready is false in docs/01: email 3 offers the checklist, which is not ready to send");
  }
  return out;
}

/** The validation context for a lead (templateSentences: the docs/09 copy stays allowed in hand edits of tier C emails). */
export function validationContext(d: Dossier, deps: Pick<WriteDeps, "style" | "offer" | "facts" | "approved">, original?: SequenceEmail[]): ValidationContext {
  return {
    style: deps.style,
    offer: deps.offer,
    dossier: d,
    verifiedFacts: deps.facts,
    approvedSentences: deps.approved.map((s) => s.text),
    ...(original ? { templateSentences: Object.fromEntries(original.map((e) => [e.n, splitCopy(e.body)])) } : {}),
  };
}

/** Sentences and bullet lines of an email's copy (used to allow the original copy in hand edits). */
function splitCopy(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l) => l.replace(/^[-*]\s+/, "").split(/(?<=[.?!:])\s+/))
    .filter(Boolean);
}

/** The old docs/09 fixed copy for a lead (no model call). No longer used to generate new sequences (every tier is model-written); kept for edit.ts's legacy "original copy" allowlist. */
export function templateSequence(leadId: string, d: Dossier, deps: WriteDeps, override: DirectContactOverride | null): Sequence {
  const segment = leadSegment(d, deps.templates);
  const emails = assembleEmails({ dossier: d, templates: deps.templates, style: deps.style, approved: deps.approved, firstName: firstNameFor(d, override) });
  const primary = isFound(d.firm_type) ? d.firm_type.value.primary : "other";
  return SequenceSchema.parse({ lead_id: leadId, tier: "C", persona: `docs/09 ${segment}`, angle: deps.style.firm_type_angles[primary][0]!, emails });
}

/** The sender's own details the emails may state (docs/01): supported facts for the judge. */
export function senderSettings(o: OfferConfig): Record<string, string> {
  return {
    company: o.company_name.trim(),
    what_the_company_does: o.company_one_liner.trim(),
    founding_client_offer: (o.founding_client_offer ?? "").trim(),
    region: o.region.trim(),
    booking_link: o.booking_link.trim(),
  };
}

/** Runs the judge over the model-written and edited emails (dossier values only). budgetSinceRunId: await lastRunId(deps.runsDb) at the call site (it can't default-await an async value here). */
export async function judgeEmails(leadId: string, d: Dossier, emails: SequenceEmail[], deps: WriteDeps, budgetSinceRunId: number): Promise<JudgeOutput> {
  const toJudge = judgedEmails(emails);
  const values = verifiedValues(d, deps.offer, deps.evidence).prospect_facts;
  const message: Anthropic.Message = (
    await deps.llm.call(
      { callType: "judge", leadId, budgetSinceRunId },
      {
        model: deps.modelWrite,
        max_tokens: MAX_OUTPUT_TOKENS.judge,
        thinking: { type: "disabled" },
        tools: [judgeTool()],
        tool_choice: { type: "tool", name: JUDGE_TOOL_NAME },
        system: [{ type: "text", text: deps.judgeSystem, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: judgeMessage(values, deps.approved.map((a) => a.text), toJudge, senderSettings(deps.offer)) }],
      },
    )
  ).message;
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === JUDGE_TOOL_NAME);
  const parsed = JudgeOutputSchema.safeParse(block?.input);
  // An unreadable verdict never passes.
  return parsed.success
    ? parsed.data
    : { unsupported_claims: [{ email: toJudge[0]?.n ?? 1, claim: "The judge's answer could not be read; run it again.", reason: "other" }] };
}

/**
 * Generates a lead's sequence by fit gate (docs/06); the tier no longer decides template vs. AI:
 *  - out_of_icp or needs_review: nothing is written unless the founder approved the gate.
 *  - Any qualified tier (A, B, or C): the writer model writes all five emails in the docs/03 examples'
 *    voice (which now include the old docs/09 fixed copy as one more style example), from verified
 *    values only. Code splices the approved docs/02 sentence at [[APPROVED]] in email 2 and runs the
 *    validators; on errors the writer rewrites once from its own draft and the errors. The judge then
 *    checks for unsupported claims. "passed" means validators and judge are both clean.
 */
export async function generateSequence(
  leadId: string,
  dossier: Dossier,
  tier: Tier,
  deps: WriteDeps,
  opts: { gateApproved?: boolean; directContactOverride?: DirectContactOverride | null } = {},
): Promise<GenerateResult> {
  const override = opts.directContactOverride ?? null;
  const base: GenerateResult = {
    leadId,
    tier,
    status: "no_sequence",
    reason: "",
    sequence: null,
    validation: null,
    judge: null,
    drafts: [],
    firstPassValid: null,
    writerCalls: 0,
    judgeCalls: 0,
    sequenceId: null,
    contactWarning: contactWarning(dossier),
    exportBlockers: [],
  };
  if (dossier.gate.status !== "qualified" && !opts.gateApproved) {
    const reason = notWrittenReason(dossier.gate);
    await logWriteAttempt(deps.eventsDb, leadId, reason);
    return { ...base, reason };
  }

  const vctx = validationContext(dossier, deps);
  let sequence: Sequence;
  let judge: JudgeOutput | null = null;
  let drafts: Draft[] = [];
  let writerCalls = 0;
  let judgeCalls = 0;
  let note: string | null = null;

  const budgetSinceRunId = await lastRunId(deps.runsDb);
  const input = writerInput(dossier, deps, firstNameFor(dossier, override));
  try {
    const w = await writeSequenceEmails(leadId, dossier, tier, deps, vctx, {
      firstName: firstNameFor(dossier, override),
      review: (emails) => judgeEmails(leadId, dossier, emails, deps, budgetSinceRunId),
    });
    drafts = w.drafts;
    writerCalls = w.writerCalls;
    note = w.note;
    if (!w.emails) {
      // Two unusable answers: nothing to show but the reason (the lead page keeps it).
      const reason = `Not written: the writer's answers could not be used (${drafts.map((x) => x.formatProblem).filter(Boolean).join("; ")}). Write again.`;
      await logWriteAttempt(deps.eventsDb, leadId, reason);
      return { ...base, reason, drafts, writerCalls };
    }
    sequence = SequenceSchema.parse({ lead_id: leadId, tier, persona: input.persona, angle: deps.style.firm_type_angles[writerType(dossier)][0]!, emails: w.emails });
    judge = w.judge;
    judgeCalls = w.judgeCalls;
  } catch (err) {
    if (!(err instanceof BudgetExceededError)) throw err;
    const reason = `Not written: stopped by the lead's token budget (${err.message}).`;
    await logWriteAttempt(deps.eventsDb, leadId, reason);
    return { ...base, reason, drafts, writerCalls };
  }

  const validation = validateSequence(sequence, vctx);
  const needsJudge = judgedEmails(sequence.emails).length > 0;
  const judgePass = !needsJudge || (judge !== null && judge.unsupported_claims.length === 0);
  const status: SequenceStatus = validation.pass && judgePass ? "passed" : "blocked";
  const reason =
    status === "passed"
      ? ["validators and judge passed", note].filter(Boolean).join("; ")
      : [note, !validation.pass ? "validator errors remain after the rewrite" : "", !judgePass ? "the judge still listed unsupported claims after the rewrite" : ""].filter(Boolean).join("; ");
  const sequenceId = await deps.sequencesDb.insert({
    leadId,
    tier,
    status,
    sequenceJson: sequence,
    validationJson: { validation, drafts },
    judgeJson: judge ? ({ result: judge, content_hash: judgedContentHash(sequence.emails) } satisfies StoredJudge) : null,
  });
  if (status !== "passed" || note) await logWriteAttempt(deps.eventsDb, leadId, `${status === "passed" ? "Written" : "Written, needs fixes"}: ${reason}.`);
  return {
    ...base,
    status,
    reason,
    sequence,
    validation,
    judge,
    drafts,
    firstPassValid: drafts[0] ? !drafts[0].formatProblem && drafts[0].errors.length === 0 : null,
    writerCalls,
    judgeCalls,
    sequenceId,
    exportBlockers: exportBlockers(deps.offer, sequence),
  };
}

/**
 * Approval is refused unless the sequence is the lead's newest and passed the code validators and the
 * judge. A missing named contact never blocks approval.
 */
export async function approveSequence(sequencesDb: SequencesDb, sequenceId: number, now: () => Date = () => new Date()): Promise<void> {
  const row = await sequencesDb.get(sequenceId);
  if (!row) throw new ApprovalBlockedError(`sequence ${sequenceId} not found`);
  const newestId = await sequencesDb.newestIdForLead(row.leadId);
  if (newestId !== row.id) throw new ApprovalBlockedError(`sequence ${sequenceId} is not the lead's newest sequence`);
  if (row.status !== "passed") throw new ApprovalBlockedError(`sequence ${sequenceId} is ${row.status}; approval needs the code validators and the judge to pass`);
  await sequencesDb.update(sequenceId, { status: "approved", approvedAt: now().toISOString() });
}
