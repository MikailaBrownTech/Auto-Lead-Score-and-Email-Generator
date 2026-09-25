import { SequenceSchema, type Dossier, type JudgeOutput, type Sequence, type SequenceEmail, type Tier } from "@clearpath/shared";
import { readStoredDossier } from "../pipeline/stored-dossier";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { leads, sequences, type SequenceStatus } from "../db/schema";
import { contactWarning, leadOverride, type DirectContactOverride } from "../scoring/direct-contact";
import { validateSequence, type ValidationContext, type ValidationResult } from "../validators/email";
import {
  exportBlockers,
  firstNameFor,
  judgedContentHash,
  judgedEmails,
  judgeEmails,
  modelEmailsFor,
  templateSequence,
  validationContext,
  type StoredJudge,
  type WriteDeps,
} from "./generate";
import { lastRunId } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { WRITER_TOOL_NAME } from "@clearpath/shared";
import { rewriteMessage, writerTool } from "./prompt";
import { detectGrounding, verifiedValues } from "./values";
import { buildEmail, toolInput, writerInput, type Draft } from "./writer";
import { z } from "zod";
import { WriterEmailSchema } from "@clearpath/shared";

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
  /** Verified values (grounding detection for edits). */
  values: Record<string, unknown>;
  vctx: ValidationContext;
  judge: StoredJudge | null;
  /** The writer drafts that produced this sequence (first, rewrite), with their errors. */
  drafts: Draft[];
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
  // Tier C: the docs/09 copy as first assembled stays allowed when the founder edits an email.
  const original = sequence.emails.some((e) => e.template) ? templateSequence(row.leadId, dossier, deps, override).emails : undefined;
  const stored = JSON.parse(row.validationJson) as { drafts?: Draft[] } | null;
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
    judge: row.judgeJson ? (JSON.parse(row.judgeJson) as StoredJudge) : null,
    drafts: (stored?.drafts ?? []).map((d) => ({ attempt: d.attempt, formatProblem: d.formatProblem ?? null, errors: d.errors ?? [] })),
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
  /** "passed" when validators pass and the judge (if required) cleared this exact content. */
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

function store(db: Db, id: number, seq: Sequence, state: SequenceState, judge: StoredJudge | null): void {
  db.update(sequences)
    .set({ sequenceJson: JSON.stringify(seq), status: state.status, judgeJson: judge ? JSON.stringify(judge) : null, approvedAt: null })
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

/** Runs the judge on demand over the model-written and edited emails, and stores the result. */
export async function runJudge(db: Db, sequenceId: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const seq = ctx.sequence;
  const judge: StoredJudge | null = judgedEmails(seq.emails).length > 0 ? { result: await judgeEmails(ctx.leadId, ctx.dossier, seq.emails, deps), content_hash: judgedContentHash(seq.emails) } : null;
  const state = sequenceState(ctx, seq, judge, deps);
  store(db, sequenceId, seq, state, judge);
  return { ...state, sequence: seq };
}

const RewriteOutput = z.object({ emails: z.array(WriterEmailSchema.strip()).min(1) });

/**
 * Rewrites one email (tiers A and B): the writer gets the same input, the current sequence as its draft,
 * and that email's validator problems, and rewrites only that email. The judge must run again after.
 */
export async function rewriteOne(db: Db, sequenceId: number, n: number, deps: WriteDeps): Promise<SequenceState & { sequence: Sequence }> {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  if (!modelEmailsFor(ctx.tier).includes(n)) {
    throw new SequenceError(`Tier ${ctx.tier} leads use the docs/09 fixed copy with no model call. Edit email ${n} by hand instead.`);
  }
  const input = writerInput(ctx.dossier, deps, firstNameFor(ctx.dossier, ctx.override));
  const current = { emails: ctx.sequence.emails.map((e) => ({ n: e.n, subject_a: e.subject_a, subject_b: e.subject_b, body: e.body })) };
  const issues = sequenceState(ctx, ctx.sequence, ctx.judge, deps).validation.issues.filter((i) => i.email === n && i.severity === "error");
  const problems = issues.length ? issues.map((i) => i.message) : ["the founder asked for a fresh version of this email"];
  const message = (
    await deps.llm.call(
      { callType: "write", leadId: ctx.leadId, budgetSinceRunId: lastRunId(db) },
      {
        model: deps.modelWrite,
        max_tokens: MAX_OUTPUT_TOKENS.write,
        thinking: { type: "disabled" },
        tools: [writerTool()],
        tool_choice: { type: "tool", name: WRITER_TOOL_NAME },
        system: [{ type: "text", text: deps.writerSystem(ctx.leadId), cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: rewriteMessage(input, current, problems, n) }],
      },
    )
  ).message;
  let raw: unknown;
  try {
    raw = toolInput(message);
  } catch {
    throw new SequenceError("The model did not answer in the expected format. Nothing was changed; try again.");
  }
  const parsed = RewriteOutput.safeParse(raw);
  const w = parsed.success ? parsed.data.emails.find((e) => e.n === n) : undefined;
  if (!w) throw new SequenceError(`The rewrite of email ${n} came back in the wrong shape. Nothing was changed; try again.`);
  const { email } = buildEmail(w, input, deps.style.send_days[n - 1]!, true);
  const seq = SequenceSchema.parse({ ...ctx.sequence, emails: ctx.sequence.emails.map((e) => (e.n === n ? email : e)) });
  const state = sequenceState(ctx, seq, null, deps);
  store(db, sequenceId, seq, state, null);
  return { ...state, sequence: seq };
}
