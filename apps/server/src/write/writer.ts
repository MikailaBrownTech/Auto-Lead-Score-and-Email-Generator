import type Anthropic from "@anthropic-ai/sdk";
import {
  APPROVED_MARKER,
  isFound,
  WRITER_TOOL_NAME,
  WriterEmailSchema,
  type Dossier,
  type FirmType,
  type JudgeOutput,
  type SequenceEmail,
  type Tier,
} from "@clearpath/shared";
import { z } from "zod";
import { lastRunId } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { validateSequence, type Issue, type ValidationContext } from "../validators/email";
import type { WriteDeps } from "./generate";
import { rewriteMessage, writerMessage, writerTool, type WriterInput } from "./prompt";
import { approvedFor, detectGrounding, verifiedValues } from "./values";

/** docs/08 persona for a firm type (the PERSONA heading that names the type). */
export function personaFor(type: FirmType, headings: string[]): string {
  const key: Record<FirmType, RegExp> = {
    cpa: /\bcpa\b/i,
    tax_preparer: /tax preparer/i,
    bookkeeper: /bookkeeper/i,
    payroll: /payroll/i,
    credit_counseling: /credit counsel/i,
    collections: /collection/i,
    credit_repair: /tax preparer/i,
    other: /\bcpa\b/i,
  };
  return headings.find((h) => key[type].test(h)) ?? headings[0] ?? "small financial firm";
}

/** The type the writer writes for: the qualifying type (docs/06) when the primary type is not a target. */
export function writerType(d: Dossier): FirmType {
  return d.target_industry_fit.qualifying_type ?? (isFound(d.firm_type) ? d.firm_type.value.primary : "other");
}

/** The writer's whole input, decided by code. Verified values only; never evidence quotes or page text. */
export function writerInput(d: Dossier, deps: Pick<WriteDeps, "offer" | "evidence" | "style" | "approved" | "personas">, firstName: string | null): WriterInput {
  const type = writerType(d);
  const o = deps.offer;
  return {
    facts: verifiedValues(d, o, deps.evidence).prospect_facts,
    firmType: type,
    persona: personaFor(type, deps.personas),
    angle: deps.style.firm_type_angles[type][0]!,
    firstName,
    sender: { company: o.company_name.trim(), one_liner: o.company_one_liner.trim(), offer: (o.founding_client_offer ?? "").trim(), region: o.region.trim() },
    approvedSentence: approvedFor(2, type, deps.approved)?.text ?? null,
  };
}

/** One writer draft as used, with the problems the code found (report and sequence page). */
export interface Draft {
  attempt: number;
  /** Set when the answer could not be used at all. */
  formatProblem: string | null;
  errors: Issue[];
}

const LenientOutput = z.object({ emails: z.array(WriterEmailSchema.strip()).min(1).max(5) });

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

/**
 * On a rewrite, the model occasionally echoes the shape of the `<your_draft>` block it was shown
 * ({ emails: [...] }) as the value of its own "emails" key, doubly nesting the array: { emails: {
 * emails: [...] } }. Unwrap one level when that's what happened.
 */
function unwrapDoubleNesting(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  const inner = obj.emails;
  if (inner && typeof inner === "object" && !Array.isArray(inner) && Array.isArray((inner as Record<string, unknown>).emails)) {
    return inner;
  }
  return input;
}

export function toolInput(message: Anthropic.Message): unknown {
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === WRITER_TOOL_NAME);
  if (!block) throw new Error(`the model did not call ${WRITER_TOOL_NAME} (stop_reason: ${message.stop_reason})`);
  return unwrapDoubleNesting(unstringify(block.input));
}

const GREETING_RE = /^(hi|hello|dear)\b[^\n]*,\s*$/i;
const MARKER_LINE_RE = /^[ \t]*\[\[\s*APPROVED\s*\]\][ \t]*$/gim;

/**
 * Turns one writer email into a sequence email: the approved docs/02 sentence spliced in at the marker
 * (email 2), a missing "Hi <name>," added for a tied contact, grounding found by code in the text.
 * When `repair` is on, a missing marker in email 2 is fixed by code (the sentence goes before the last
 * paragraph) and stray markers elsewhere are dropped.
 */
export function buildEmail(
  w: { n: number; subject_a: string | null; subject_b: string | null; body: string },
  input: WriterInput,
  sendDay: number,
  repair: boolean,
): { email: SequenceEmail; problems: string[] } {
  const problems: string[] = [];
  let body = w.body.replace(/\r\n/g, "\n").trim();
  const markers = body.match(MARKER_LINE_RE)?.length ?? 0;
  const inline = (body.match(/\[\[\s*APPROVED\s*\]\]/gi)?.length ?? 0) - markers;
  if (w.n === 2 && input.approvedSentence) {
    if (markers + inline === 0) {
      problems.push(`email 2: the ${APPROVED_MARKER} marker is missing; put it on its own line where the requirement belongs`);
      if (repair) {
        const paras = body.split(/\n\s*\n/);
        paras.splice(Math.max(1, paras.length - 1), 0, input.approvedSentence);
        body = paras.join("\n\n");
      }
    } else {
      if (markers + inline > 1) problems.push(`email 2: use the ${APPROVED_MARKER} marker once`);
      // Always its own paragraph, so it stays one sentence even when the marker was placed inline.
      let first = true;
      body = body.replace(/[ \t]*\[\[\s*APPROVED\s*\]\][ \t]*/gi, () => {
        const out = first ? `\n\n${input.approvedSentence!}\n\n` : "";
        first = false;
        return out;
      });
    }
  } else if (markers + inline > 0) {
    problems.push(`email ${w.n}: the ${APPROVED_MARKER} marker belongs only in email 2`);
    body = body.replace(/\[\[\s*APPROVED\s*\]\]/gi, "");
  }
  body = body.replace(/\n{3,}/g, "\n\n").trim();
  // A tied contact is greeted by name in email 1 (repairable by code).
  if (w.n === 1 && input.firstName && !new RegExp(`^(hi|hello|dear)\\s+${input.firstName}\\s*,`, "i").test(body)) {
    const firstLine = body.split("\n")[0]!;
    body = `Hi ${input.firstName},\n\n${GREETING_RE.test(firstLine) ? body.split("\n").slice(1).join("\n").trim() : body}`;
  }
  const text = [body.replace(/^[^\n]*\n/, ""), w.subject_a ?? "", w.subject_b ?? ""].join(" ");
  return {
    problems,
    email: {
      n: w.n,
      send_day: sendDay,
      subject_a: w.n === 1 || w.n >= 3 ? (w.subject_a ?? null) : null,
      subject_b: w.n === 1 ? (w.subject_b ?? null) : null,
      body,
      grounding: detectGrounding(text, input.facts),
      template: false,
    },
  };
}

/** A problem list for a rewrite from the judge's unsupported claims. */
export function judgeProblems(claims: { email: number; claim: string; reason: string }[]): string[] {
  return claims.map((c) => `email ${c.email}: the second check found an unsupported claim (${c.reason.replace(/_/g, " ")}): "${c.claim}". Remove it or say it without claiming it.`);
}

export interface WriteResult {
  emails: SequenceEmail[] | null;
  drafts: Draft[];
  writerCalls: number;
  /** The judge's verdict on the final emails (null when no review was given or nothing usable). */
  judge: JudgeOutput | null;
  judgeCalls: number;
  /** Why the result is not the clean first draft (a repair or an unusable answer), in plain words. */
  note: string | null;
}

/**
 * Writes all five emails (every tier): one writer call. The draft goes through the validators and,
 * when they pass, the judge (`review`). On validator errors or judge claims, one rewrite gets its own
 * draft plus the specific problems and rewrites naturally. The best usable draft is kept (the judge runs
 * again on a rewrite); code-repairable problems (a missing marker, a missing name greeting) are
 * repaired after the rewrite. At most two writer calls and two judge calls.
 */
export async function writeSequenceEmails(
  leadId: string,
  d: Dossier,
  tier: Tier,
  deps: WriteDeps,
  vctx: ValidationContext,
  opts: { firstName: string | null; exampleKey?: string; review?: (emails: SequenceEmail[]) => Promise<JudgeOutput> } = { firstName: null },
): Promise<WriteResult> {
  const input = writerInput(d, deps, opts.firstName);
  const system = deps.writerSystem(opts.exampleKey ?? leadId);
  const budgetSinceRunId = lastRunId(deps.db);
  const call = async (text: string) =>
    (
      await deps.llm.call(
        { callType: "write", leadId, budgetSinceRunId },
        {
          model: deps.modelWrite,
          max_tokens: MAX_OUTPUT_TOKENS.write,
          thinking: { type: "disabled" },
          tools: [writerTool()],
          tool_choice: { type: "tool", name: WRITER_TOOL_NAME },
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: text }],
        },
      )
    ).message;

  const drafts: Draft[] = [];
  const apply = (raw: unknown, attempt: number, repair: boolean) => {
    const parsed = LenientOutput.safeParse(raw);
    const byN = parsed.success ? new Map(parsed.data.emails.map((e) => [e.n, e])) : new Map();
    const missing = [1, 2, 3, 4, 5].filter((n) => !byN.has(n));
    const formatProblem = !parsed.success
      ? `the answer could not be read: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      : missing.length
        ? `email(s) ${missing.join(", ")} missing`
        : null;
    if (formatProblem) {
      drafts.push({ attempt, formatProblem, errors: [] });
      return { emails: null, problems: [formatProblem], errors: [] as Issue[] };
    }
    const built = [1, 2, 3, 4, 5].map((n) => buildEmail(byN.get(n)!, input, deps.style.send_days[n - 1]!, repair));
    const emails = built.map((b) => b.email);
    const splice = built.flatMap((b) => b.problems);
    const errors = validateSequence({ lead_id: leadId, tier, persona: input.persona, angle: input.angle, emails }, vctx).issues.filter((i) => i.severity === "error");
    drafts.push({ attempt, formatProblem: null, errors });
    return { emails, problems: [...(repair ? [] : splice), ...errors.map((i) => `${i.email ? `email ${i.email}: ` : ""}${i.message}`)], errors };
  };

  const firstRaw = toolInput(await call(writerMessage(input)));
  let result = apply(firstRaw, 1, false);
  let writerCalls = 1;
  let note: string | null = null;
  let judge: JudgeOutput | null = null;
  let judgeCalls = 0;
  let judged: string | null = null;
  const key = (emails: SequenceEmail[]) => JSON.stringify(emails.map((e) => [e.subject_a, e.subject_b, e.body]));
  if (result.problems.length === 0 && result.emails && opts.review) {
    judge = await opts.review(result.emails);
    judgeCalls++;
    judged = key(result.emails);
    if (judge.unsupported_claims.length > 0) result = { ...result, problems: judgeProblems(judge.unsupported_claims) };
  }
  if (result.problems.length > 0) {
    writerCalls++;
    const againRaw = toolInput(await call(rewriteMessage(input, firstRaw, result.problems)));
    const again = apply(againRaw, 2, true);
    const firstRepaired = result.emails ? apply(firstRaw, 1, true) : null;
    drafts.splice(2); // keep the two real attempts in the report; the repaired recheck is internal
    // The rewrite wins unless it is unusable or has more errors than the (repaired) first draft.
    if (again.emails && (!firstRepaired?.emails || again.errors.length <= firstRepaired.errors.length)) result = again;
    else if (firstRepaired?.emails) {
      result = firstRepaired;
      note = again.emails ? "the rewrite had more problems than the first draft, so the first draft is kept" : "the rewrite could not be used, so the first draft is kept";
    }
  }
  if (result.emails && opts.review && key(result.emails) !== judged) {
    judge = await opts.review(result.emails);
    judgeCalls++;
  }
  return { emails: result.emails, drafts, writerCalls, note, judge: result.emails ? judge : null, judgeCalls };
}
