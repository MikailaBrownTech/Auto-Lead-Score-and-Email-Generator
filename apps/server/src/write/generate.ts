import type Anthropic from "@anthropic-ai/sdk";
import {
  isFound,
  JUDGE_TOOL_NAME,
  JudgeOutputSchema,
  SequenceSchema,
  WRITER_TOOL_NAME,
  WriterOutputSchema,
  countWords,
  type Dossier,
  type EvidenceConfig,
  type FirmType,
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
import { sequences, type SequenceStatus } from "../db/schema";
import { templateEmail, type TemplateSet } from "../docs/templates";
import { BudgetExceededError, lastRunId, type LlmClient } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { contactPlan } from "../scoring/contact";
import { validateSequence, type ValidationResult } from "../validators/email";
import { judgeMessage, judgeTool, rewriteMessage, writerMessage, writerTool, type WriteRequest } from "./prompt";
import { buildWriterInput, detectGrounding } from "./writer-input";

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
  /** VERIFIED docs/02 facts given to the writer (money/penalty facts removed). */
  facts: RegulatoryFact[];
}

export interface GenerateResult {
  leadId: string;
  /** no_sequence: gated or not writable. blocked: generated but validators or judge failed. passed: approvable. */
  status: "no_sequence" | SequenceStatus;
  reason: string;
  tier: Tier;
  sequence: Sequence | null;
  validation: ValidationResult | null;
  judge: JudgeOutput | null;
  /** Personal-detail filter log for the writer input. */
  filtered: string[];
  writerCalls: number;
  judgeCalls: number;
  sequenceId: number | null;
}

/** Which emails the writer writes, by tier (docs/06): A all five, B emails 1-2, C none. */
export function customEmailsFor(tier: Tier): number[] {
  return tier === "A" ? [1, 2, 3, 4, 5] : tier === "B" ? [1, 2] : [];
}

const PURPOSES: Record<number, string> = {
  1: "custom observation plus one question",
  2: "one Safeguards/IRS requirement relevant to their firm type plus one custom detail",
  3: "offer the cta_type item by reply",
  4: "founding-client offer if approved, otherwise a short useful checklist",
  5: "brief break-up",
};

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
  return block.input;
}

function params(deps: WriteDeps, system: string, tool: Anthropic.Tool, text: string, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: deps.modelWrite,
    max_tokens: maxTokens,
    // Forced tool use; thinking off explicitly so the forced call is allowed on models that default to adaptive.
    thinking: { type: "disabled" },
    // Static prefix first (tools, then system), cacheable; the lead's facts go in the user message.
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
  };
}

/** Template type for email 2: the qualifying type when the primary type is not a target (credit repair + tax prep). */
function templateType(d: Dossier): FirmType | null {
  return d.target_industry_fit.qualifying_type ?? (isFound(d.firm_type) ? d.firm_type.value.primary : null);
}

/**
 * Generates a lead's sequence by tier and gate (docs/06):
 *  - out_of_icp or needs_review: nothing is written unless the founder approved the gate.
 *  - Tier C: all five emails from docs/09 templates; no writer or judge call.
 *  - Tier B: writer emails 1-2, templates 3-5. Tier A: writer emails 1-5.
 * The writer sees verified values only. Code validators run on every email; if they fail, the writer
 * gets one rewrite with the problems listed. The judge (A/B) lists unsupported claims in the custom
 * emails. The sequence is "passed" (approvable) only when both are clean.
 */
export async function generateSequence(
  leadId: string,
  dossier: Dossier,
  tier: Tier,
  deps: WriteDeps,
  opts: { gateApproved?: boolean } = {},
): Promise<GenerateResult> {
  const base = { leadId, tier, sequence: null, validation: null, judge: null, filtered: [], writerCalls: 0, judgeCalls: 0, sequenceId: null };
  if (dossier.gate.status !== "qualified" && !opts.gateApproved) {
    return { ...base, status: "no_sequence", reason: `gate is ${dossier.gate.status}; no sequence until the founder approves it (${dossier.gate.reasons.join("; ")})` };
  }

  const plan = contactPlan(dossier);
  const firmRef = isFound(dossier.firm_name) ? dossier.firm_name.value : "your firm";
  const type = templateType(dossier);
  const vars = { greeting: plan.greeting, firm_ref: firmRef, cta_url: deps.offer.cta_url };
  const angles = dossier && isFound(dossier.firm_type)
    ? [...new Set([dossier.firm_type.value.primary, ...dossier.firm_type.value.secondary].flatMap((t) => deps.style.firm_type_angles[t]))]
    : deps.style.firm_type_angles.other;
  // Prefer the qualifying type's angle (the reason the lead is in scope).
  const defaultAngle = (type ? deps.style.firm_type_angles[type][0] : undefined) ?? angles[0]!;
  const customNs = customEmailsFor(tier);
  const templated = (n: number): SequenceEmail => templateEmail(deps.templates, n, type, vars, deps.style, deps.offer.cta_type);
  const input = buildWriterInput(dossier, deps.offer, deps.evidence);
  const vctx = { style: deps.style, offer: deps.offer, dossier, verifiedFacts: deps.facts };

  let persona = `template (${type ?? "other"})`;
  let angle = defaultAngle;
  let emails: SequenceEmail[] = [1, 2, 3, 4, 5].map(templated);
  let writerCalls = 0;
  let judgeCalls = 0;
  let judge: JudgeOutput | null = null;
  let reason = customNs.length === 0 ? `tier ${tier}: templates only, no writer or judge call` : "";

  const assemble = (): Sequence => SequenceSchema.parse({ lead_id: leadId, tier, persona, angle, emails });
  let sequence: Sequence;

  if (customNs.length > 0) {
    const greetingWords = countWords(plan.greeting);
    const request: WriteRequest = {
      facts: input.prospect_facts,
      emails: customNs.map((n) => ({
        n,
        wordLimit: n <= 4 ? deps.style.word_limits[String(n) as "1"] - greetingWords : null,
        purpose: PURPOSES[n]!,
      })),
      angles,
      subjectMaxWords: deps.style.subject_max_words,
    };
    const budgetSinceRunId = lastRunId(deps.db);
    const call = async (callType: "write" | "judge", system: string, tool: Anthropic.Tool, text: string) =>
      (await deps.llm.call({ callType, leadId, budgetSinceRunId }, params(deps, system, tool, text, MAX_OUTPUT_TOKENS[callType]))).message;

    const applyDraft = (raw: unknown): string | null => {
      const parsed = WriterOutputSchema.safeParse(raw);
      if (!parsed.success) return `writer output invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
      const byN = new Map(parsed.data.emails.map((e) => [e.n, e]));
      const missing = customNs.filter((n) => !byN.has(n));
      if (missing.length > 0) return `writer did not write email(s) ${missing.join(", ")}`;
      persona = parsed.data.persona;
      angle = parsed.data.angle;
      emails = [1, 2, 3, 4, 5].map((n) => {
        const w = byN.get(n);
        if (!w || !customNs.includes(n)) return templated(n);
        const body = w.body.trim().replace(GREETING_LINE, "").trim();
        return {
          n,
          send_day: deps.style.send_days[n - 1]!,
          subject_a: n === 1 ? w.subject_a : null,
          subject_b: n === 1 ? w.subject_b : null,
          body: `${plan.greeting}\n${body}`,
          // The writer's list plus every fact the code finds in the text (subjects included).
          grounding: [...new Set([...w.grounding, ...detectGrounding([body, w.subject_a ?? "", w.subject_b ?? ""].join(" "), input.prospect_facts)])],
          template: false,
        };
      });
      return null;
    };

    try {
      writerCalls++;
      const formatProblem = applyDraft(unstringify(toolInput(await call("write", deps.writerSystem, writerTool(), writerMessage(request)), WRITER_TOOL_NAME)));
      let validation = formatProblem ? null : validateSequence(assemble(), vctx);
      const problems = formatProblem
        ? [formatProblem]
        : validation!.issues.filter((i) => i.severity === "error" && (i.email === null || customNs.includes(i.email))).map((i) => `${i.email ? `email ${i.email}: ` : ""}${i.message}`);
      if (problems.length > 0) {
        // One rewrite with the code's findings; never more.
        writerCalls++;
        const again = applyDraft(unstringify(toolInput(await call("write", deps.writerSystem, writerTool(), rewriteMessage(request, problems)), WRITER_TOOL_NAME)));
        if (again) return save({ ...base, status: "blocked", reason: again, filtered: input.filtered, writerCalls, judgeCalls, sequence: null });
        validation = validateSequence(assemble(), vctx);
      }
      judgeCalls++;
      const custom = emails.filter((e) => customNs.includes(e.n));
      const judged = JudgeOutputSchema.safeParse(unstringify(toolInput(await call("judge", deps.judgeSystem, judgeTool(), judgeMessage(input.prospect_facts, custom)), JUDGE_TOOL_NAME)));
      // An unreadable verdict never passes; the reason is kept for the report.
      judge = judged.success
        ? judged.data
        : { unsupported_claims: [{ email: 1, claim: `judge output could not be read: ${judged.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`.slice(0, 200), reason: "other" }] };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        return save({ ...base, status: "blocked", reason: `budget_exceeded: ${err.message}`, filtered: input.filtered, writerCalls, judgeCalls, sequence: null });
      }
      throw err;
    }
  }

  sequence = assemble();
  const validation = validateSequence(sequence, vctx);
  const judgePass = judge === null || judge.unsupported_claims.length === 0;
  const status: SequenceStatus = validation.pass && judgePass ? "passed" : "blocked";
  if (!reason) {
    reason = status === "passed" ? "validators and judge passed" : [!validation.pass ? "code validators failed" : "", !judgePass ? "judge listed unsupported claims" : ""].filter(Boolean).join("; ");
  } else if (status === "blocked") reason += "; code validators failed";
  return save({ ...base, status, reason, sequence, validation, judge, filtered: input.filtered, writerCalls, judgeCalls });

  function save(r: GenerateResult): GenerateResult {
    const row = deps.db
      .insert(sequences)
      .values({
        leadId,
        tier,
        status: r.status === "no_sequence" ? "blocked" : r.status,
        sequenceJson: JSON.stringify(r.sequence),
        validationJson: JSON.stringify(r.validation),
        judgeJson: r.judge ? JSON.stringify(r.judge) : null,
      })
      .returning({ id: sequences.id })
      .get();
    return { ...r, sequenceId: row.id };
  }
}

/** Approval is refused unless the lead's newest sequence passed the code validators and the judge. */
export function approveSequence(db: Db, sequenceId: number, now: () => Date = () => new Date()): void {
  const row = db.select().from(sequences).where(eq(sequences.id, sequenceId)).get();
  if (!row) throw new ApprovalBlockedError(`sequence ${sequenceId} not found`);
  const newest = db.select({ id: sequences.id }).from(sequences).where(eq(sequences.leadId, row.leadId)).orderBy(desc(sequences.id)).limit(1).get();
  if (newest?.id !== row.id) throw new ApprovalBlockedError(`sequence ${sequenceId} is not the lead's newest sequence`);
  if (row.status !== "passed") throw new ApprovalBlockedError(`sequence ${sequenceId} is ${row.status}; approval needs code validators and judge to pass`);
  db.update(sequences).set({ status: "approved", approvedAt: now().toISOString() }).where(eq(sequences.id, sequenceId)).run();
}
