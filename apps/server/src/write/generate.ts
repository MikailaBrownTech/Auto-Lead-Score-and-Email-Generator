import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
  isFound,
  JUDGE_TOOL_NAME,
  JudgeOutputSchema,
  SequenceSchema,
  WRITER_TOOL_NAME,
  WriterEmailSchema,
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
import { readStoredDossier } from "../pipeline/stored-dossier";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { leadEvents, leads, sequences, type SequenceStatus } from "../db/schema";
import { templateEmail, type TemplateSet } from "../docs/templates";
import { BudgetExceededError, lastRunId, type LlmClient } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { contactPlan } from "../scoring/contact";
import { directContactBlockers, leadOverride, type DirectContactOverride } from "../scoring/direct-contact";
import { validateSequence, type Issue, type ValidationResult } from "../validators/email";
import { judgeMessage, judgeTool, rewriteMessage, writerMessage, writerTool } from "./prompt";
import { detectGrounding, planSequence, type EmailPlan, type WritePlan } from "./writer-input";

export class ApprovalBlockedError extends Error {
  override name = "ApprovalBlockedError";
}

export interface WriteDeps {
  db: Db;
  llm: LlmClient;
  modelWrite: string;
  writerSystem: string;
  judgeSystem: string;
  style: StyleConfig;
  offer: OfferConfig;
  evidence: EvidenceConfig;
  templates: TemplateSet;
  /** VERIFIED docs/02 facts (money/penalty facts removed). */
  facts: RegulatoryFact[];
  /** Usable docs/02 approved sentences (loadApprovedSentences). */
  approved: ApprovedSentence[];
  /** docs/08 "PERSONA:" headings. */
  personas: string[];
}

/** One writer email as drafted, with the code-inserted sentences kept apart from the model's words. */
export interface DraftEmail {
  n: number;
  subject_a: string | null;
  subject_b: string | null;
  /** Model-written text before the slot. */
  opening: string;
  /** Code-inserted, verbatim (DNS remark and/or approved docs/02 sentence). */
  inserted: { id: string; text: string }[];
  /** Model-written text after the slot. */
  closing: string;
}

/** Every writer draft, including blocked ones, with the validator errors it got (report mode). */
export interface Draft {
  attempt: number;
  emails: DraftEmail[];
  /** Set when the writer's output could not be used at all. */
  formatProblem: string | null;
  errors: Issue[];
}

export interface GenerateResult {
  leadId: string;
  /** no_sequence: gated. blocked: validators or judge failed. passed: content approvable. */
  status: "no_sequence" | SequenceStatus;
  reason: string;
  tier: Tier;
  plan: WritePlan | null;
  sequence: Sequence | null;
  validation: ValidationResult | null;
  judge: JudgeOutput | null;
  drafts: Draft[];
  /** True when the first draft had no validator errors. */
  firstPassValid: boolean | null;
  rewritesUsed: number;
  writerCalls: number;
  judgeCalls: number;
  sequenceId: number | null;
  /** Reasons approval is refused even when the content passed (e.g. needs_direct_contact). */
  approvalBlockers: string[];
  /** Reasons export is refused (approval blockers plus footer, signature, checklist_ready). */
  exportBlockers: string[];
}

/**
 * One writer email assembled by code: greeting + the model's opening + the code-inserted sentences
 * (DNS remark, approved docs/02 sentence) + the model's closing. Grounding is what the code finds in
 * the model's own words (subjects included), plus the DNS remark.
 */
export function buildWriterEmail(
  p: EmailPlan,
  w: { subject_a: string | null; subject_b: string | null; opening: string; closing: string },
  greeting: string,
  style: StyleConfig,
  values: Record<string, unknown>,
): { email: SequenceEmail; draft: DraftEmail } {
  const n = p.n;
  const inserted = [
    ...(p.dnsSentence ? [{ id: "dns_observation", text: p.dnsSentence }] : []),
    ...(p.approved ? [{ id: p.approved.id, text: p.approved.text }] : []),
  ];
  const opening = w.opening.trim().replace(GREETING_LINE, "").trim();
  const closing = w.closing.trim();
  const subject_a = n === 1 ? w.subject_a : null;
  const subject_b = n === 1 ? w.subject_b : null;
  const modelText = [opening, closing, subject_a ?? "", subject_b ?? ""].join(" ");
  return {
    draft: { n, subject_a, subject_b, opening, inserted, closing },
    email: {
      n,
      send_day: style.send_days[n - 1]!,
      subject_a,
      subject_b,
      body: `${greeting}\n${[opening, ...inserted.map((i) => i.text), closing].filter(Boolean).join(" ")}`,
      grounding: [...new Set([...detectGrounding(modelText, values), ...(p.dnsSentence ? ["dns_observation" as const] : [])])],
      template: false,
    },
  };
}

/** The judge verdict as stored, tied to the exact content it judged. */
export interface StoredJudge {
  result: JudgeOutput;
  content_hash: string;
}

/** Emails that need the judge: model-written or hand-edited ones. Untouched templates do not. */
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
export function logWriteAttempt(db: Db, leadId: string, detail: string): void {
  db.insert(leadEvents).values({ leadId, kind: "write_attempt", detail: detail.slice(0, 1000) }).run();
}

/** Which emails the writer writes, by tier (docs/06): A all five, B emails 1-2, C none. */
export function customEmailsFor(tier: Tier): number[] {
  return tier === "A" ? [1, 2, 3, 4, 5] : tier === "B" ? [1, 2] : [];
}

/** A lead without a person-tied address needs one first (or a global or per-lead override). */
export function approvalBlockers(d: Dossier, offer: OfferConfig, override: DirectContactOverride | null = null): string[] {
  return directContactBlockers(d, offer, override);
}

export function exportBlockers(d: Dossier, offer: OfferConfig, seq: Sequence | null, override: DirectContactOverride | null = null): string[] {
  const out = [...approvalBlockers(d, offer, override)];
  const empty = (["sender_title", "company_name", "company_website", "opt_out_line", "physical_address"] as const).filter((k) => offer[k].trim() === "");
  if (empty.length > 0) out.push(`docs/01 settings empty: ${empty.join(", ")}`);
  if (seq?.emails.some((e) => e.n === 3) && offer.cta_type === "checklist" && !offer.checklist_ready) {
    out.push("checklist_ready is false in docs/01: email 3 offers the checklist, which is not ready to send");
  }
  return out;
}

const LenientWriterOutput = z.object({ emails: z.array(WriterEmailSchema.strip()).min(1).max(5) });

const GREETING_LINE = /^(hi|hello|dear)\b[^.?!\n]*,\s*\n/i;

/** Models occasionally send an array field as a JSON string ("[...]"); parse those before validating. */
function unstringify(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => {
      if (typeof v === "string" && /^\s*[[{]/.test(v)) {
        try {
          return [k, JSON.parse(v)];
        } catch {
          return [k, v];
        }
      }
      return [k, v];
    }),
  );
}

function toolInput(message: Anthropic.Message, name: string): unknown {
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === name);
  if (!block) throw new Error(`the model did not call ${name} (stop_reason: ${message.stop_reason})`);
  return unstringify(block.input);
}

function params(deps: WriteDeps, system: string, tool: Anthropic.Tool, text: string, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: deps.modelWrite,
    max_tokens: maxTokens,
    // Forced tool use with thinking off (explicitly, since some models default to adaptive thinking).
    thinking: { type: "disabled" },
    // Static prefix first (tools, then system), cacheable; the lead's facts go in the user message.
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
  };
}

/**
 * Generates a lead's sequence by tier and gate (docs/06):
 *  - out_of_icp or needs_review: nothing is written unless the founder approved the gate.
 *  - Tier C: all five emails from docs/09 templates; no writer or judge call.
 *  - Tier B: writer emails 1-2, templates 3-5. Tier A: writer emails 1-5.
 * The writer gets only code-chosen inputs (one detail per email, the persona, the angle) and writes
 * only the words around a slot; approved docs/02 sentences are inserted verbatim by code. Validators
 * run on every email; on errors the writer gets one rewrite. The judge (A/B) checks custom emails.
 * "passed" means both are clean; approval can still be blocked (needs_direct_contact).
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
    plan: null,
    sequence: null,
    validation: null,
    judge: null,
    drafts: [],
    firstPassValid: null,
    rewritesUsed: 0,
    writerCalls: 0,
    judgeCalls: 0,
    sequenceId: null,
    approvalBlockers: approvalBlockers(dossier, deps.offer, override),
    exportBlockers: [],
  };
  if (dossier.gate.status !== "qualified" && !opts.gateApproved) {
    const reason = notWrittenReason(dossier.gate);
    logWriteAttempt(deps.db, leadId, reason);
    return { ...base, reason };
  }

  // An overridden lead (no person-tied address) is always greeted neutrally.
  const greeting = override ? "Hi," : contactPlan(dossier).greeting;
  const customNs = customEmailsFor(tier);
  const plan = planSequence(dossier, customNs, { ...deps, greeting });
  const type = plan.context.firm_type;
  const vars = { greeting, firm_ref: isFound(dossier.firm_name) ? dossier.firm_name.value : "your firm", cta_url: deps.offer.cta_url };
  const templated = (n: number): SequenceEmail => templateEmail(deps.templates, n, type, vars, deps.style, deps.offer.cta_type);
  const vctx = {
    style: deps.style,
    offer: deps.offer,
    dossier,
    verifiedFacts: deps.facts,
    approvedSentences: deps.approved.map((s) => s.text),
    assignedDetails: Object.fromEntries(plan.emails.map((e) => [e.n, e.detail?.field ?? null])),
  };

  let emails: SequenceEmail[] = [1, 2, 3, 4, 5].map(templated);
  const drafts: Draft[] = [];
  let judge: JudgeOutput | null = null;
  let writerCalls = 0;
  let judgeCalls = 0;
  /** Why the result is not the model's clean draft (unusable rewrite, budget stop), shown on the lead page. */
  let writeNote: string | null = null;
  const assemble = (persona: string, angle: string): Sequence => SequenceSchema.parse({ lead_id: leadId, tier, persona, angle, emails });
  const persona = customNs.length > 0 ? plan.context.persona : `template (${type})`;
  const angle = plan.context.angle;

  /** Turns the writer's output into emails: greeting + opening + inserted sentences + closing. */
  const applyDraft = (raw: unknown, attempt: number): Draft => {
    // Unknown extra keys are dropped (only known fields are ever read); missing or wrong fields still fail.
    const parsed = LenientWriterOutput.safeParse(raw);
    const byN = parsed.success ? new Map(parsed.data.emails.map((e) => [e.n, e])) : new Map();
    const missing = customNs.filter((n) => !byN.has(n));
    const formatProblem = !parsed.success
      ? `writer output invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      : missing.length > 0
        ? `writer did not write email(s) ${missing.join(", ")}`
        : null;
    const draftEmails: DraftEmail[] = [];
    if (!formatProblem) {
      emails = [1, 2, 3, 4, 5].map((n) => {
        const p = plan.emails.find((e) => e.n === n);
        const w = byN.get(n);
        if (!p || !w) return templated(n);
        const built = buildWriterEmail(p, w, greeting, deps.style, plan.values);
        draftEmails.push(built.draft);
        return built.email;
      });
    }
    const errors = formatProblem ? [] : validateSequence(assemble(persona, angle), vctx).issues.filter((i) => i.severity === "error");
    const draft = { attempt, emails: draftEmails, formatProblem, errors };
    drafts.push(draft);
    return draft;
  };

  if (customNs.length > 0) {
    const budgetSinceRunId = lastRunId(deps.db);
    const call = async (callType: "write" | "judge", system: string, tool: Anthropic.Tool, text: string) =>
      (await deps.llm.call({ callType, leadId, budgetSinceRunId }, params(deps, system, tool, text, MAX_OUTPUT_TOKENS[callType]))).message;
    try {
      writerCalls++;
      const first = applyDraft(toolInput(await call("write", deps.writerSystem, writerTool(), writerMessage(plan, deps.style.subject_max_words)), WRITER_TOOL_NAME), 1);
      const problems = first.formatProblem ? [first.formatProblem] : first.errors.map((i) => `${i.email ? `email ${i.email}: ` : ""}${i.message}`);
      if (problems.length > 0) {
        // Exactly one rewrite with the code's findings; never more.
        writerCalls++;
        const again = applyDraft(toolInput(await call("write", deps.writerSystem, writerTool(), rewriteMessage(plan, deps.style.subject_max_words, problems)), WRITER_TOOL_NAME), 2);
        // An unusable rewrite never throws away what we have: the first draft (with its errors) stays
        // on screen for editing, or the template emails when the first draft was unusable too.
        if (again.formatProblem) {
          writeNote = `The model's rewrite could not be used (${again.formatProblem}), so ${first.formatProblem ? "the template emails are shown instead" : "the first draft is shown with its errors"}. Edit it, or write again.`;
        }
      }
      const custom = emails.filter((e) => !e.template);
      if (custom.length > 0) {
        judgeCalls++;
        const judged = JudgeOutputSchema.safeParse(toolInput(await call("judge", deps.judgeSystem, judgeTool(), judgeMessage(plan, custom)), JUDGE_TOOL_NAME));
        // An unreadable verdict never passes; the reason is kept for the report.
        judge = judged.success
          ? judged.data
          : { unsupported_claims: [{ email: 1, claim: `judge output could not be read: ${judged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`.slice(0, 200), reason: "other" }] };
      }
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      // The lead's token budget stopped the run: keep whatever was drafted so far, blocked.
      writeNote = `Stopped by the lead's token budget: ${err.message} What was drafted so far is shown.`;
    }
  }

  const sequence = assemble(persona, angle);
  const validation = validateSequence(sequence, vctx);
  // Model-written emails need a clean judge verdict; templates-only sequences do not.
  const needsJudge = sequence.emails.some((e) => !e.template);
  const judgePass = !needsJudge || (judge !== null && judge.unsupported_claims.length === 0);
  const status: SequenceStatus = validation.pass && judgePass ? "passed" : "blocked";
  const reason =
    status === "passed"
      ? writeNote ??
        (customNs.length === 0
        ? `tier ${tier}: templates only, no writer or judge call; validators passed`
        : "validators and judge passed")
      : [writeNote ?? "", !validation.pass ? "code validators failed" : "", !judgePass ? (judge ? "judge listed unsupported claims" : "the judge has not run on these emails") : ""].filter(Boolean).join("; ");
  const saved = save({
    ...base,
    status,
    reason,
    plan,
    sequence,
    validation,
    judge,
    drafts,
    firstPassValid: drafts[0] ? drafts[0].errors.length === 0 && !drafts[0].formatProblem : null,
    rewritesUsed: Math.max(0, drafts.length - 1),
    writerCalls,
    judgeCalls,
  });
  // Logged after the sequence row, so the lead page ties this note to the sequence it describes.
  if (status !== "passed" || writeNote) logWriteAttempt(deps.db, leadId, `${status === "passed" ? "Written" : "Written, needs fixes"}: ${reason.replace(/\.$/, "")}.`);
  return saved;

  function save(r: GenerateResult): GenerateResult {
    const row = deps.db
      .insert(sequences)
      .values({
        leadId,
        tier,
        status: r.status === "no_sequence" ? "blocked" : r.status,
        sequenceJson: JSON.stringify(r.sequence),
        validationJson: JSON.stringify({ validation: r.validation, drafts: r.drafts }),
        judgeJson: r.judge && r.sequence ? JSON.stringify({ result: r.judge, content_hash: judgedContentHash(r.sequence.emails) } satisfies StoredJudge) : null,
      })
      .returning({ id: sequences.id })
      .get();
    return { ...r, sequenceId: row.id, exportBlockers: exportBlockers(dossier, deps.offer, r.sequence, override) };
  }
}

/**
 * Approval is refused unless the sequence is the lead's newest, passed the code validators and the
 * judge, and the lead has a usable contact (not needs_direct_contact).
 */
export function approveSequence(db: Db, sequenceId: number, offer: OfferConfig, now: () => Date = () => new Date()): void {
  const row = db.select().from(sequences).where(eq(sequences.id, sequenceId)).get();
  if (!row) throw new ApprovalBlockedError(`sequence ${sequenceId} not found`);
  const newest = db.select({ id: sequences.id }).from(sequences).where(eq(sequences.leadId, row.leadId)).orderBy(desc(sequences.id)).limit(1).get();
  if (newest?.id !== row.id) throw new ApprovalBlockedError(`sequence ${sequenceId} is not the lead's newest sequence`);
  if (row.status !== "passed") throw new ApprovalBlockedError(`sequence ${sequenceId} is ${row.status}; approval needs code validators and judge to pass`);
  const lead = db.select({ dossierJson: leads.dossierJson }).from(leads).where(eq(leads.id, row.leadId)).get();
  if (lead?.dossierJson) {
    const blockers = approvalBlockers(readStoredDossier(lead.dossierJson), offer, leadOverride(db, row.leadId));
    if (blockers.length > 0) throw new ApprovalBlockedError(blockers.join("; "));
  }
  db.update(sequences).set({ status: "approved", approvedAt: now().toISOString() }).where(eq(sequences.id, sequenceId)).run();
}
