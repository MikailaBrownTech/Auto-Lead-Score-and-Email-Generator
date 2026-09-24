import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL_NAME, FACT_FIELDS, NOT_FOUND, type EvidenceConfig, type ExtractedFacts, type FactField } from "@clearpath/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { extractions } from "../db/schema";
import { BudgetExceededError, type LlmClient } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { extractionTool, firstPassMessage, retryMessage } from "./prompt";
import type { SentPage } from "./token-caps";
import { citedUrl, FIXABLE_FAILURES, itemSupported, pagesForRetry, verifyExtraction, type FieldCheck, type VerifyContext } from "./verify";

export class ExtractionError extends Error {
  override name = "ExtractionError";
}

export interface FieldReport extends FieldCheck {
  /** True when this field went through the targeted retry. */
  retried: boolean;
  /** The first-pass rejection reason, when the field was retried. */
  firstReason?: string;
}

export interface ExtractionResult {
  facts: ExtractedFacts;
  fields: Record<FactField, FieldReport>;
  retriesUsed: 0 | 1;
  retryUrls: string[];
  modelFlaggedInjection: boolean;
  fromCache: boolean;
  /** True when the lead's token budget stopped the retry. */
  budgetExceeded: boolean;
  failures: string[];
}

export interface ExtractionDeps {
  llm: LlmClient;
  db: Db;
  model: string;
  systemPrompt: string;
  evidence: EvidenceConfig;
  leadId: string;
  /** runs.id when this research run started; the per-lead token budget counts only calls after it. */
  budgetSinceRunId?: number;
  /** Skip the extraction cache (still writes the new result). */
  refresh?: boolean;
}

/** Bump when verification or prompt assembly changes in a way that should invalidate cached results. */
const EXTRACTION_VERSION = 4;

function cacheKey(deps: ExtractionDeps, tool: Anthropic.Tool, sent: SentPage[]): string {
  const material = JSON.stringify({
    v: EXTRACTION_VERSION,
    model: deps.model,
    system: deps.systemPrompt,
    tool,
    evidence: deps.evidence,
    pages: sent.map((p) => [p.url, p.kind, p.title, crypto.createHash("sha256").update(p.text).digest("hex")]),
  });
  return crypto.createHash("sha256").update(material).digest("hex");
}

function toolInput(message: Anthropic.Message): Record<string, unknown> {
  const block = message.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === EXTRACTION_TOOL_NAME,
  );
  if (!block || typeof block.input !== "object" || block.input === null) {
    throw new ExtractionError(`the model did not call ${EXTRACTION_TOOL_NAME} (stop_reason: ${message.stop_reason})`);
  }
  return block.input as Record<string, unknown>;
}

function params(deps: ExtractionDeps, tool: Anthropic.Tool, userText: string, maxTokens: number): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: deps.model,
    max_tokens: maxTokens,
    // Static prefix first (tools, then system), marked cacheable; per-lead pages go in the user message.
    tools: [tool],
    tool_choice: { type: "tool", name: EXTRACTION_TOOL_NAME },
    system: [{ type: "text", text: deps.systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userText }],
  };
}

/**
 * Union of a partially verified list field and its retry result. Each side was verified on its own;
 * services/software keep at most 3 quotes, and items are kept only if a kept quote supports them.
 */
function mergeList(field: FactField, a: unknown, b: unknown): unknown {
  if (field === "people" || field === "exclusion_signals") {
    const items = [...(a as Record<string, unknown>[]), ...(b as Record<string, unknown>[])];
    const key = (x: Record<string, unknown>) => String(x.name ?? x.signal).toLowerCase();
    return items.filter((x, i) => items.findIndex((y) => key(y) === key(x)) === i).slice(0, 5);
  }
  if (a === NOT_FOUND) return b;
  if (b === NOT_FOUND) return a;
  const la = a as { value: string[]; evidence: { evidence_url: string; evidence_quote: string }[] };
  const lb = b as typeof la;
  const evidence = [...la.evidence, ...lb.evidence]
    .filter((e, i, all) => all.findIndex((x) => x.evidence_quote === e.evidence_quote) === i)
    .slice(0, 3);
  const quotes = evidence.map((e) => e.evidence_quote).join(" \n ");
  const value = [...la.value, ...lb.value]
    .filter((v, i, all) => all.findIndex((x) => x.toLowerCase() === v.toLowerCase()) === i)
    .filter((v) => itemSupported(v, quotes));
  return value.length > 0 ? { value, evidence } : a;
}

function emptyValue(field: FactField): unknown {
  return field === "people" || field === "exclusion_signals" ? [] : NOT_FOUND;
}

/**
 * One extraction call over the capped page text, then at most one targeted retry: only the fields
 * whose failure is fixable (quote not found, value not supported by its quote, personal details,
 * wrong page), with only the relevant page text. Format failures are not retried. Fields still
 * unverified become NOT_FOUND with a failure note. Results are cached by the exact text sent.
 */
export async function extractFacts(sent: SentPage[], deps: ExtractionDeps): Promise<ExtractionResult> {
  const tool = extractionTool();
  const key = cacheKey(deps, tool, sent);

  if (!deps.refresh) {
    const hit = deps.db.select().from(extractions).where(eq(extractions.cacheKey, key)).orderBy(desc(extractions.id)).limit(1).get();
    if (hit) return { ...(JSON.parse(hit.resultJson) as ExtractionResult), fromCache: true };
  }

  const ctx: VerifyContext = { pages: new Map(sent.map((p) => [p.url, { text: p.text, title: p.title }])), evidence: deps.evidence };
  const first = await deps.llm.call(
    { callType: "extract", leadId: deps.leadId, budgetSinceRunId: deps.budgetSinceRunId },
    params(deps, tool, firstPassMessage(sent), MAX_OUTPUT_TOKENS.extract),
  );
  const input1 = toolInput(first.message);
  const v1 = verifyExtraction(input1, ctx);
  let modelFlaggedInjection = input1.suspected_prompt_injection === true;

  const fields = Object.fromEntries(FACT_FIELDS.map((f) => [f, { ...v1.checks[f], retried: false }])) as Record<FactField, FieldReport>;
  const facts: ExtractedFacts = { ...v1.facts };
  const failures: string[] = FACT_FIELDS.flatMap((f) => v1.checks[f].notes ?? []);

  const rejected = FACT_FIELDS.filter((f) => v1.checks[f].status === "rejected");
  const partial = FACT_FIELDS.filter((f) => v1.checks[f].status === "verified" && v1.checks[f].partial);
  const fixable = [...rejected.filter((f) => FIXABLE_FAILURES.has(v1.checks[f].kind!)), ...partial];
  for (const field of rejected.filter((f) => !fixable.includes(f))) {
    failures.push(`${field}: set to NOT_FOUND, not retried (${v1.checks[field].reason})`);
  }

  let retriesUsed: 0 | 1 = 0;
  let retryUrls: string[] = [];
  let budgetExceeded = false;

  if (fixable.length > 0) {
    retryUrls = pagesForRetry(
      fixable.map((field) => ({ field, citedUrl: citedUrl(v1.checks[field].answer) })),
      sent,
    );
    const retryPages = sent.filter((p) => retryUrls.includes(p.url));
    const reasons = fixable.map((field) => ({ field, reason: v1.checks[field].reason ?? "failed verification" }));

    let input2: Record<string, unknown> | null = null;
    try {
      const second = await deps.llm.call(
        { callType: "extract_retry", leadId: deps.leadId, budgetSinceRunId: deps.budgetSinceRunId },
        params(deps, tool, retryMessage(retryPages, reasons), MAX_OUTPUT_TOKENS.extract_retry),
      );
      retriesUsed = 1;
      input2 = toolInput(second.message);
      modelFlaggedInjection ||= input2.suspected_prompt_injection === true;
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      budgetExceeded = true;
    }

    const retryCtx: VerifyContext = { ...ctx, pages: new Map(retryPages.map((p) => [p.url, { text: p.text, title: p.title }])) };
    const v2 = input2 ? verifyExtraction(input2, retryCtx, fixable) : null;
    for (const field of fixable) {
      const firstReason = v1.checks[field].reason;
      const check = v2?.checks[field];
      if (partial.includes(field)) {
        // The first pass already produced a usable list; merge in whatever the retry verified.
        if (v2 && check?.status === "verified") {
          (facts as Record<string, unknown>)[field] = mergeList(field, facts[field], v2.facts[field]);
          failures.push(...(check.notes ?? []));
        }
        fields[field] = { ...fields[field], retried: !!v2, firstReason };
        continue;
      }
      if (v2 && check?.status === "verified") {
        (facts as Record<string, unknown>)[field] = v2.facts[field];
        fields[field] = { ...check, retried: true, firstReason };
        failures.push(...(check.notes ?? []));
        continue;
      }
      (facts as Record<string, unknown>)[field] = emptyValue(field);
      const second = !v2 ? "retry skipped: lead token budget reached" : check?.status === "not_found" ? "retry returned NOT_FOUND" : `retry: ${check?.reason}`;
      fields[field] = { status: "rejected", kind: check?.kind ?? v1.checks[field].kind, reason: second, answer: check?.answer ?? v1.checks[field].answer, retried: !!v2, firstReason };
      failures.push(`${field}: evidence not verified, set to NOT_FOUND (first pass: ${firstReason}; ${second})`);
    }
  }

  const result: ExtractionResult = {
    facts,
    fields,
    retriesUsed,
    retryUrls,
    modelFlaggedInjection,
    fromCache: false,
    budgetExceeded,
    failures,
  };
  if (!budgetExceeded) {
    deps.db.insert(extractions).values({ leadId: deps.leadId, cacheKey: key, model: deps.model, resultJson: JSON.stringify(result) }).run();
  }
  return result;
}
