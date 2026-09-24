import crypto from "node:crypto";
import {
  isFound,
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
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, sequences, type SequenceStatus } from "../db/schema";
import { fallbackLine, type TemplateSet } from "../docs/templates";
import type { LlmClient } from "../llm/client";
import { contactPlan } from "../scoring/contact";
import { contactWarning, type DirectContactOverride } from "../scoring/direct-contact";
import { validateSequence, type ValidationContext, type ValidationResult } from "../validators/email";
import { assembleEmails, leadSegment, type PersonalLine } from "./assemble";
import { emptySettingsUsed } from "./merge";
import { writePersonalLine, type LineResult } from "./personal-line";
import { verifiedValues } from "./values";

export class ApprovalBlockedError extends Error {
  override name = "ApprovalBlockedError";
}

export interface WriteDeps {
  db: Db;
  llm: LlmClient;
  /** Small model for {{personal_line}} (one call per lead). */
  modelLine: string;
  lineSystem: string;
  /** Model for the on-demand judge of hand-edited emails. */
  modelJudge: string;
  judgeSystem: string;
  style: StyleConfig;
  offer: OfferConfig;
  evidence: EvidenceConfig;
  /** docs/09_sequences.md */
  templates: TemplateSet;
  /** VERIFIED docs/02 facts (money/penalty facts removed); for the judge prompt. */
  facts: RegulatoryFact[];
  /** Usable docs/02 approved sentences (loadApprovedSentences). */
  approved: ApprovedSentence[];
}

export interface GenerateResult {
  leadId: string;
  /** no_sequence: gated. blocked: a validator error the code could not repair (docs/09 copy or settings). passed: approvable. */
  status: "no_sequence" | SequenceStatus;
  reason: string;
  tier: Tier;
  sequence: Sequence | null;
  validation: ValidationResult | null;
  /** The personal line and why the fallback was used (a note, never an error). */
  personalLine: (LineResult & { usedFallbackAfterAssembly: boolean }) | null;
  modelCalls: number;
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

/**
 * Emails that need the judge: those the founder edited by hand. docs/09 copy is human-written and the
 * personal line is checked by code, so an unedited sequence needs no judge call.
 */
export function judgedEmails(emails: SequenceEmail[]): SequenceEmail[] {
  return emails.filter((e) => e.edited);
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

/** Emails whose personal line the model writes, by tier: A and B email 1; C none (fallback line, no call). */
export function modelEmailsFor(tier: Tier): number[] {
  return tier === "C" ? [] : [1];
}

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

/** The validation context for a lead's sequence (templateSentences: the docs/09 copy stays allowed in edits). */
export function validationContext(d: Dossier, deps: WriteDeps, original?: SequenceEmail[]): ValidationContext {
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

/** Builds the sequence from docs/09 for a personal line. */
export function buildSequence(leadId: string, d: Dossier, tier: Tier, deps: WriteDeps, line: PersonalLine, subject: "A" | "B" | null, override: DirectContactOverride | null): Sequence {
  const segment = leadSegment(d, deps.templates);
  const emails = assembleEmails({
    dossier: d,
    templates: deps.templates,
    style: deps.style,
    approved: deps.approved,
    personalLine: line,
    firstName: firstNameFor(d, override),
    subjectChoice: subject,
    values: verifiedValues(d, deps.offer, deps.evidence).prospect_facts,
  });
  // The angle tag (Results screen) follows the lead's own primary type; the copy follows its docs/09 segment.
  const primary = isFound(d.firm_type) ? d.firm_type.value.primary : "other";
  return SequenceSchema.parse({ lead_id: leadId, tier, persona: `docs/09 ${segment}`, angle: deps.style.firm_type_angles[primary][0]!, emails });
}

/**
 * Generates a lead's sequence (template-first):
 *  - out_of_icp or needs_review: nothing is written unless the founder approved the gate.
 *  - Every email is docs/09 copy assembled by code. The model writes only {{personal_line}} in
 *    email 1 (tiers A and B: one small call; tier C: the fallback line, no call).
 *  - Anything the code can repair is repaired: a failed call or a line that fails the checks uses the
 *    docs/09 fallback line; if the assembled email 1 still fails with the model's line, the fallback
 *    line replaces it. Only problems in the docs/09 copy or settings can leave a sequence blocked.
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
    personalLine: null,
    modelCalls: 0,
    sequenceId: null,
    contactWarning: contactWarning(dossier),
    exportBlockers: [],
  };
  if (dossier.gate.status !== "qualified" && !opts.gateApproved) {
    const reason = notWrittenReason(dossier.gate);
    logWriteAttempt(deps.db, leadId, reason);
    return { ...base, reason };
  }

  const line = await writePersonalLine(leadId, dossier, deps, { call: modelEmailsFor(tier).includes(1), firstName: firstNameFor(dossier, override) });
  const vctx = validationContext(dossier, deps);
  let sequence = buildSequence(leadId, dossier, tier, deps, line.line, line.subject, override);
  let validation = validateSequence(sequence, vctx);
  let usedFallbackAfterAssembly = false;
  const e1Errors = (v: ValidationResult) => v.issues.filter((i) => i.severity === "error" && i.email === 1).length;
  if (line.line.source === "model" && e1Errors(validation) > 0) {
    const fb: PersonalLine = { text: fallbackLine(leadSegment(dossier, deps.templates), deps.templates), source: "fallback" };
    const seq2 = buildSequence(leadId, dossier, tier, deps, fb, null, override);
    const v2 = validateSequence(seq2, vctx);
    if (e1Errors(v2) < e1Errors(validation)) {
      const problems = validation.issues.filter((i) => i.severity === "error" && i.email === 1).map((i) => i.message);
      line.rejected = line.line.text;
      line.note = `email 1 did not pass with the model's line (${problems.join("; ")}), so the docs/09 fallback line is used`;
      line.line = fb;
      line.subject = null;
      [sequence, validation, usedFallbackAfterAssembly] = [seq2, v2, true];
    }
  }

  const status: SequenceStatus = validation.pass ? "passed" : "blocked";
  const lineNote = line.line.source === "model" ? "personal line written by the model" : `personal line: ${line.note}`;
  const reason = status === "passed" ? `validators passed; ${lineNote}` : `the docs/09 copy or settings fail a validator (edit the email or docs/09); ${lineNote}`;
  const row = deps.db
    .insert(sequences)
    .values({ leadId, tier, status, sequenceJson: JSON.stringify(sequence), validationJson: JSON.stringify({ validation, personalLine: line }), judgeJson: null })
    .returning({ id: sequences.id })
    .get();
  if (status !== "passed") logWriteAttempt(deps.db, leadId, `Written, needs fixes: ${reason}.`);
  return {
    ...base,
    status,
    reason,
    sequence,
    validation,
    personalLine: { ...line, usedFallbackAfterAssembly },
    modelCalls: line.called ? 1 : 0,
    sequenceId: row.id,
    exportBlockers: exportBlockers(deps.offer, sequence),
  };
}

/**
 * Approval is refused unless the sequence is the lead's newest and passed the code validators (and
 * the judge, when emails were edited by hand). A missing named contact never blocks approval.
 */
export function approveSequence(db: Db, sequenceId: number, now: () => Date = () => new Date()): void {
  const row = db.select().from(sequences).where(eq(sequences.id, sequenceId)).get();
  if (!row) throw new ApprovalBlockedError(`sequence ${sequenceId} not found`);
  const newest = db.select({ id: sequences.id }).from(sequences).where(eq(sequences.leadId, row.leadId)).orderBy(desc(sequences.id)).limit(1).get();
  if (newest?.id !== row.id) throw new ApprovalBlockedError(`sequence ${sequenceId} is not the lead's newest sequence`);
  if (row.status !== "passed") throw new ApprovalBlockedError(`sequence ${sequenceId} is ${row.status}; approval needs the code validators (and the judge for hand edits) to pass`);
  db.update(sequences).set({ status: "approved", approvedAt: now().toISOString() }).where(eq(sequences.id, sequenceId)).run();
}
