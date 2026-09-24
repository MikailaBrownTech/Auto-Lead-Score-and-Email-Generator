import type Anthropic from "@anthropic-ai/sdk";
import {
  isFound,
  JUDGE_TOOL_NAME,
  JudgeOutputSchema,
  SequenceSchema,
  type Dossier,
  type JudgeOutput,
  type Sequence,
  type SequenceEmail,
  type Tier,
} from "@clearpath/shared";
import { readStoredDossier } from "../pipeline/stored-dossier";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { leads, sequences, type SequenceStatus } from "../db/schema";
import { lastRunId } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { contactWarning, leadOverride, type DirectContactOverride } from "../scoring/direct-contact";
import { validateSequence, type ValidationContext, type ValidationResult } from "../validators/email";
import type { PersonalLine } from "./assemble";
import { buildSequence, exportBlockers, firstNameFor, judgedContentHash, judgedEmails, modelEmailsFor, validationContext, type StoredJudge, type WriteDeps } from "./generate";
import { writePersonalLine, type LineResult } from "./personal-line";
import { judgeMessage, judgeTool } from "./prompt";
import { detectGrounding, verifiedValues } from "./values";

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
  /** Verified values (grounding detection for edits; the judge's facts). */
  values: Record<string, unknown>;
  vctx: ValidationContext;
  judge: StoredJudge | null;
  /** How the personal line was made (model or fallback, and why), from the write. */
  personalLine: Pick<LineResult, "line" | "note" | "rejected"> | null;
}

export function loadSequenceContext(db: Db, sequenceId: number, deps: WriteDeps): SequenceContext {
  const row = db.select().from(sequences).where(eq(sequences.id, sequenceId)).get();
  if (!row) throw new SequenceError(`Sequence ${sequenceId} was not found.`);
  const sequence = row.sequenceJson ? (JSON.parse(row.sequenceJson) as Sequence | null) : null;
  if (!sequence) throw new SequenceError("This sequence has no emails. Write the sequence again.");
  const lead = db.select().from(leads).where(eq(leads.id, row.leadId)).get();
  if (!lead?.dossierJson) throw new SequenceError(`Lead ${row.leadId} has no research yet.`);
  const dossier = readStoredDossier(lead.dossierJson);
  const override = leadOverride(db, row.leadId);
  const stored = JSON.parse(row.validationJson) as { personalLine?: LineResult } | null;
  const line: PersonalLine = sequence.emails[0]?.personal_line ?? stored?.personalLine?.line ?? { text: "", source: "fallback" };
  // The docs/09 copy as first assembled stays allowed when the founder edits an email.
  const original = line.text ? buildSequence(row.leadId, dossier, row.tier, deps, line, null, override).emails : undefined;
  const judge = row.judgeJson ? (JSON.parse(row.judgeJson) as StoredJudge) : null;
  return {
    id: row.id,
    leadId: row.leadId,
    tier: row.tier,
    status: row.status,
    sequence,
    dossier,
    override,
    values: verifiedValues(dossier, deps.offer, deps.evidence).prospect_facts,
    vctx: validationContext(dossier, deps, original),
    judge,
    personalLine: stored?.personalLine ? { line: stored.personalLine.line, note: stored.personalLine.note, rejected: stored.personalLine.rejected } : null,
  };
}

/**
 * Applies the founder's edits to a sequence: an email whose subject or body changed is marked
 * edited, and its grounding is recomputed by code from the new text.
 */
export function applyEdits(ctx: SequenceContext, edits: { n: number; subject_a?: string | null; subject_b?: string | null; body: string }[]): Sequence {
  const emails = ctx.sequence.emails.map((e): SequenceEmail => {
    const edit = edits.find((x) => x.n === e.n);
    if (!edit) return e;
    const subject_a = e.subject_a === null && !edit.subject_a ? null : (edit.subject_a ?? e.subject_a);
    const subject_b = e.n === 1 ? (edit.subject_b ?? e.subject_b) : null;
    const changed = edit.body !== e.body || subject_a !== e.subject_a || subject_b !== e.subject_b;
    if (!changed) return e;
    const text = [edit.body.replace(/^[^\n]*\n/, ""), subject_a ?? "", subject_b ?? ""].join(" ");
    return { ...e, subject_a, subject_b, body: edit.body, edited: true, grounding: detectGrounding(text, ctx.values) };
  });
  return SequenceSchema.parse({ ...ctx.sequence, emails });
}

export interface SequenceState {
  validation: ValidationResult;
  /** "passed" when validators pass and the judge (if emails were edited) cleared this exact content. */
  status: SequenceStatus;
  judgeRequired: boolean;
  /** The stored judge result, only if it was run on this exact content. */
  judge: JudgeOutput | null;
  /** A lead without a named contact: shown as a warning, never a blocker. */
  contactWarning: string | null;
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
    contactWarning: contactWarning(ctx.dossier),
    exportBlockers: exportBlockers(deps.offer, seq),
  };
}

function store(db: Db, id: number, seq: Sequence, state: SequenceState, judge: StoredJudge | null, personalLine?: LineResult): void {
  db.update(sequences)
    .set({
      sequenceJson: JSON.stringify(seq),
      status: state.status,
      judgeJson: judge ? JSON.stringify(judge) : null,
      approvedAt: null,
      ...(personalLine ? { validationJson: JSON.stringify({ validation: state.validation, personalLine }) } : {}),
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

function toolInput(message: Anthropic.Message, name: string): unknown {
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === name);
  if (!block) throw new SequenceError(`The model did not answer in the expected format (${message.stop_reason}). Try again.`);
  return block.input;
}

/** Runs the judge on demand over the hand-edited emails, and stores the result. */
export async function runJudge(db: Db, sequenceId: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const seq = ctx.sequence;
  const toJudge = judgedEmails(seq.emails);
  let judge: StoredJudge | null = null;
  if (toJudge.length > 0) {
    const facts = {
      firm_name: ctx.values.firm_name ?? null,
      firm_type: isFound(ctx.dossier.firm_type) ? ctx.dossier.firm_type.value.primary : null,
      location: ctx.values.location ?? null,
      services: ctx.values.services ?? [],
    };
    const message = (
      await deps.llm.call(
        { callType: "judge", leadId: ctx.leadId, budgetSinceRunId: lastRunId(db) },
        {
          model: deps.modelJudge,
          max_tokens: MAX_OUTPUT_TOKENS.judge,
          thinking: { type: "disabled" },
          tools: [judgeTool()],
          tool_choice: { type: "tool", name: JUDGE_TOOL_NAME },
          system: [{ type: "text", text: deps.judgeSystem, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: judgeMessage(facts, deps.approved.map((a) => a.text), toJudge) }],
        },
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

/**
 * Writes email 1's personal line again (one small model call; tiers A and B). Email 1 is rebuilt from
 * docs/09 with the new line (a hand edit to email 1 is replaced); the other emails are kept. A line
 * that fails the checks falls back to the docs/09 line, as on the first write.
 */
export async function rewriteOne(db: Db, sequenceId: number, n: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  if (n !== 1 || !modelEmailsFor(ctx.tier).includes(1)) {
    throw new SequenceError(
      n !== 1
        ? `Email ${n} is fixed docs/09 copy; only email 1's personal line is written by the model. Edit it by hand instead.`
        : `Tier ${ctx.tier} leads use the docs/09 fallback line with no model call. Edit email 1 by hand instead.`,
    );
  }
  const line = await writePersonalLine(ctx.leadId, ctx.dossier, deps, { call: true, firstName: firstNameFor(ctx.dossier, ctx.override) });
  const fresh = buildSequence(ctx.leadId, ctx.dossier, ctx.tier, deps, line.line, line.subject, ctx.override);
  const seq = SequenceSchema.parse({ ...ctx.sequence, emails: ctx.sequence.emails.map((e) => (e.n === 1 ? fresh.emails[0]! : e)) });
  const judge = ctx.judge && ctx.judge.content_hash === judgedContentHash(seq.emails) ? ctx.judge : null;
  const state = sequenceState(ctx, seq, judge, deps);
  store(db, sequenceId, seq, state, judge, line);
  return { ...state, sequence: seq };
}
