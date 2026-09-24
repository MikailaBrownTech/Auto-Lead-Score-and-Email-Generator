import type Anthropic from "@anthropic-ai/sdk";
import {
  isFound,
  JUDGE_TOOL_NAME,
  JudgeOutputSchema,
  SequenceSchema,
  WRITER_TOOL_NAME,
  WriterEmailSchema,
  type Dossier,
  type JudgeOutput,
  type Sequence,
  type SequenceEmail,
  type Tier,
} from "@clearpath/shared";
import { readStoredDossier } from "../pipeline/stored-dossier";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { leads, sequences, type SequenceStatus } from "../db/schema";
import { templateEmail } from "../docs/templates";
import { lastRunId } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { contactPlan } from "../scoring/contact";
import { leadOverride, type DirectContactOverride } from "../scoring/direct-contact";
import { bodySentences, validateSequence, type ValidationContext, type ValidationResult } from "../validators/email";
import {
  approvalBlockers,
  buildWriterEmail,
  customEmailsFor,
  exportBlockers,
  judgedContentHash,
  judgedEmails,
  type StoredJudge,
  type WriteDeps,
} from "./generate";
import { judgeMessage, judgeTool, writerMessage, writerTool } from "./prompt";
import { detectGrounding, planSequence, type WritePlan } from "./writer-input";

export class SequenceError extends Error {
  override name = "SequenceError";
}

/** Everything needed to check or change one stored sequence. */
export interface SequenceContext {
  id: number;
  leadId: string;
  tier: Tier;
  status: SequenceStatus;
  sequence: Sequence;
  dossier: Dossier;
  override: DirectContactOverride | null;
  greeting: string;
  plan: WritePlan;
  vctx: ValidationContext;
  judge: StoredJudge | null;
  /** The writer drafts that produced this sequence (blocked ones too), with their errors. */
  drafts: { attempt: number; formatProblem: string | null; errors: ValidationResult["issues"] }[];
}

export function loadSequenceContext(db: Db, sequenceId: number, deps: WriteDeps): SequenceContext {
  const row = db.select().from(sequences).where(eq(sequences.id, sequenceId)).get();
  if (!row) throw new SequenceError(`Sequence ${sequenceId} was not found.`);
  const sequence = row.sequenceJson ? (JSON.parse(row.sequenceJson) as Sequence | null) : null;
  if (!sequence) throw new SequenceError("This draft could not be used (see the drafts in the report). Write the sequence again.");
  const lead = db.select().from(leads).where(eq(leads.id, row.leadId)).get();
  if (!lead?.dossierJson) throw new SequenceError(`Lead ${row.leadId} has no research yet.`);
  const dossier = readStoredDossier(lead.dossierJson);
  const override = leadOverride(db, row.leadId);
  const greeting = override ? "Hi," : contactPlan(dossier).greeting;
  const plan = planSequence(dossier, customEmailsFor(row.tier), { ...deps, greeting });
  const vars = { greeting, firm_ref: isFound(dossier.firm_name) ? dossier.firm_name.value : "your firm", cta_url: deps.offer.cta_url };
  // Original template sentences stay allowed when the founder edits a template email.
  const templateSentences: Record<number, string[]> = {};
  for (const e of sequence.emails) {
    if (e.template) templateSentences[e.n] = bodySentences(templateEmail(deps.templates, e.n, plan.context.firm_type, vars, deps.style, deps.offer.cta_type).body);
  }
  const vctx: ValidationContext = {
    style: deps.style,
    offer: deps.offer,
    dossier,
    verifiedFacts: deps.facts,
    approvedSentences: deps.approved.map((s) => s.text),
    assignedDetails: Object.fromEntries(plan.emails.map((e) => [e.n, e.detail?.field ?? null])),
    templateSentences,
  };
  const judge = row.judgeJson ? (JSON.parse(row.judgeJson) as StoredJudge) : null;
  const stored = JSON.parse(row.validationJson) as { drafts?: { attempt: number; formatProblem: string | null; errors: ValidationResult["issues"] }[] } | null;
  const drafts = (stored?.drafts ?? []).map((d) => ({ attempt: d.attempt, formatProblem: d.formatProblem, errors: d.errors }));
  return { id: row.id, leadId: row.leadId, tier: row.tier, status: row.status, sequence, dossier, override, greeting, plan, vctx, judge, drafts };
}

/**
 * Applies the founder's edits to a sequence: an email whose subject or body changed is marked
 * edited, and its grounding is recomputed by code from the new text.
 */
export function applyEdits(ctx: SequenceContext, edits: { n: number; subject_a?: string | null; subject_b?: string | null; body: string }[]): Sequence {
  const emails = ctx.sequence.emails.map((e): SequenceEmail => {
    const edit = edits.find((x) => x.n === e.n);
    if (!edit) return e;
    const subject_a = e.n === 1 ? (edit.subject_a ?? e.subject_a) : null;
    const subject_b = e.n === 1 ? (edit.subject_b ?? e.subject_b) : null;
    const changed = edit.body !== e.body || subject_a !== e.subject_a || subject_b !== e.subject_b;
    if (!changed) return e;
    const text = [edit.body.replace(/^[^\n]*\n/, ""), subject_a ?? "", subject_b ?? ""].join(" ");
    return { ...e, subject_a, subject_b, body: edit.body, edited: true, grounding: detectGrounding(text, ctx.plan.values) };
  });
  return SequenceSchema.parse({ ...ctx.sequence, emails });
}

export interface SequenceState {
  validation: ValidationResult;
  /** "passed" when validators pass and the judge (if required) cleared this exact content. */
  status: SequenceStatus;
  judgeRequired: boolean;
  /** The stored judge result, only if it was run on this exact content. */
  judge: JudgeOutput | null;
  approvalBlockers: string[];
  exportBlockers: string[];
}

export function sequenceState(ctx: SequenceContext, seq: Sequence, judge: StoredJudge | null, deps: WriteDeps): SequenceState {
  const validation = validateSequence(seq, ctx.vctx);
  const judgeRequired = judgedEmails(seq.emails).length > 0;
  const current = judge && judge.content_hash === judgedContentHash(seq.emails) ? judge.result : null;
  const judgePass = !judgeRequired || (current !== null && current.unsupported_claims.length === 0);
  return {
    validation,
    status: validation.pass && judgePass ? "passed" : "blocked",
    judgeRequired,
    judge: current,
    approvalBlockers: approvalBlockers(ctx.dossier, deps.offer, ctx.override),
    exportBlockers: exportBlockers(ctx.dossier, deps.offer, seq, ctx.override),
  };
}

function store(db: Db, id: number, seq: Sequence, state: SequenceState, judge: StoredJudge | null): void {
  db.update(sequences)
    .set({
      sequenceJson: JSON.stringify(seq),
      status: state.status,
      judgeJson: judge ? JSON.stringify(judge) : null,
      approvedAt: null,
    })
    .where(eq(sequences.id, id))
    .run();
}

/** Saves edits. Any change clears an earlier approval; the judge result stays only if its content is unchanged. */
export function saveEdits(db: Db, sequenceId: number, edits: Parameters<typeof applyEdits>[1], deps: WriteDeps): SequenceState & { sequence: Sequence } {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const seq = applyEdits(ctx, edits);
  const judge = ctx.judge && ctx.judge.content_hash === judgedContentHash(seq.emails) ? ctx.judge : null;
  const state = sequenceState(ctx, seq, judge, deps);
  store(db, sequenceId, seq, state, judge);
  return { ...state, sequence: seq };
}

/** Validates edits without saving (the live check while typing). */
export function checkEdits(db: Db, sequenceId: number, edits: Parameters<typeof applyEdits>[1], deps: WriteDeps): SequenceState & { sequence: Sequence } {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const seq = applyEdits(ctx, edits);
  return { ...sequenceState(ctx, seq, ctx.judge, deps), sequence: seq };
}

function forcedParams(deps: WriteDeps, system: string, tool: Anthropic.Tool, text: string, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: deps.modelWrite,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
  };
}

function toolInput(message: Anthropic.Message, name: string): unknown {
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === name);
  if (!block) throw new SequenceError(`The model did not answer in the expected format (${message.stop_reason}). Try again.`);
  return block.input;
}

/** Runs the judge on demand over the model-written and edited emails, and stores the result. */
export async function runJudge(db: Db, sequenceId: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const seq = ctx.sequence;
  const toJudge = judgedEmails(seq.emails);
  let judge: StoredJudge | null = null;
  if (toJudge.length > 0) {
    const message = (
      await deps.llm.call(
        { callType: "judge", leadId: ctx.leadId, budgetSinceRunId: lastRunId(db) },
        forcedParams(deps, deps.judgeSystem, judgeTool(), judgeMessage(ctx.plan, toJudge), MAX_OUTPUT_TOKENS.judge),
      )
    ).message;
    const parsed = JudgeOutputSchema.safeParse(toolInput(message, JUDGE_TOOL_NAME));
    const result: JudgeOutput = parsed.success
      ? parsed.data
      : { unsupported_claims: [{ email: toJudge[0]!.n, claim: "The judge's answer could not be read; run it again.", reason: "other" }] };
    judge = { result, content_hash: judgedContentHash(seq.emails) };
  }
  const state = sequenceState(ctx, seq, judge, deps);
  store(db, sequenceId, seq, state, judge);
  return { ...state, sequence: seq };
}

const RewriteOutput = z.object({ emails: z.array(WriterEmailSchema.strip()).min(1) });

/**
 * Rewrites one writer email (only emails the tier gives the writer). Same constrained input and
 * code-inserted approved sentence as the original; the judge must be run again afterwards.
 */
export async function rewriteOne(db: Db, sequenceId: number, n: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const p = ctx.plan.emails.find((e) => e.n === n);
  if (!p) throw new SequenceError(`Email ${n} comes from the templates for a tier ${ctx.tier} lead, so it is not rewritten by the model. Edit it by hand instead.`);
  const message = (
    await deps.llm.call(
      { callType: "write", leadId: ctx.leadId, budgetSinceRunId: lastRunId(db) },
      forcedParams(deps, deps.writerSystem, writerTool(), writerMessage({ ...ctx.plan, emails: [p] }, deps.style.subject_max_words), MAX_OUTPUT_TOKENS.write),
    )
  ).message;
  const parsed = RewriteOutput.safeParse(toolInput(message, WRITER_TOOL_NAME));
  const w = parsed.success ? parsed.data.emails.find((e) => e.n === n) : undefined;
  if (!w) throw new SequenceError(`The rewrite of email ${n} came back in the wrong shape. Nothing was changed; try again.`);
  const { email } = buildWriterEmail(p, w, ctx.greeting, deps.style, ctx.plan.values);
  const seq = SequenceSchema.parse({ ...ctx.sequence, emails: ctx.sequence.emails.map((e) => (e.n === n ? email : e)) });
  const state = sequenceState(ctx, seq, null, deps);
  store(db, sequenceId, seq, state, null);
  return { ...state, sequence: seq };
}
