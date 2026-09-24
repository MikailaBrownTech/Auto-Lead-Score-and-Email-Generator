import crypto from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL_NAME, FACT_FIELDS, NOT_FOUND, type ExtractedFacts, type FactField } from "@clearpath/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { extractions } from "../db/schema";
import { BudgetExceededError, type LlmClient } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { extractionTool, firstPassMessage, retryMessage } from "./prompt";
import type { SentPage } from "./token-caps";
import { pagesForRetry, verifyExtraction, type FieldCheck } from "./verify";

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
  leadId: string;
  /** Skip the extraction cache (still writes the new result). */
  refresh?: boolean;
}

/** Bump when verification or prompt assembly changes in a way that should invalidate cached results. */
const EXTRACTION_VERSION = 1;

function cacheKey(deps: ExtractionDeps, tool: Anthropic.Tool, sent: SentPage[]): string {
  const material = JSON.stringify({
    v: EXTRACTION_VERSION,
    model: deps.model,
    system: deps.systemPrompt,
    tool,
    pages: sent.map((p) => [p.url, p.kind, crypto.createHash("sha256").update(p.text).digest("hex")]),
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
 * One extraction call over the capped page text, then at most one targeted retry: only the fields
 * that failed verification, with only the relevant page text. Fields still unverified become
 * NOT_FOUND with a failure note. Results are cached by the exact text sent, so unchanged reruns
 * make no API calls.
 */
export async function extractFacts(sent: SentPage[], deps: ExtractionDeps): Promise<ExtractionResult> {
  const tool = extractionTool();
  const key = cacheKey(deps, tool, sent);

  if (!deps.refresh) {
    const hit = deps.db.select().from(extractions).where(eq(extractions.cacheKey, key)).orderBy(desc(extractions.id)).limit(1).get();
    if (hit) return { ...(JSON.parse(hit.resultJson) as ExtractionResult), fromCache: true };
  }

  const sentMap = new Map(sent.map((p) => [p.url, p.text]));
  const first = await deps.llm.call(
    { callType: "extract", leadId: deps.leadId },
    params(deps, tool, firstPassMessage(sent), MAX_OUTPUT_TOKENS.extract),
  );
  const input1 = toolInput(first.message);
  const v1 = verifyExtraction(input1, sentMap);
  let modelFlaggedInjection = input1.suspected_prompt_injection === true;

  const fields = Object.fromEntries(
    FACT_FIELDS.map((f) => [f, { ...v1.checks[f], retried: false }]),
  ) as Record<FactField, FieldReport>;
  const facts: ExtractedFacts = { ...v1.facts };
  const failures: string[] = [];
  const failing = FACT_FIELDS.filter((f) => v1.checks[f].status === "rejected");

  let retriesUsed: 0 | 1 = 0;
  let retryUrls: string[] = [];
  let budgetExceeded = false;

  if (failing.length > 0) {
    const cited = failing.map((field) => {
      const answer = v1.checks[field].answer as { evidence_url?: unknown } | undefined;
      return { field, citedUrl: typeof answer?.evidence_url === "string" ? answer.evidence_url : null };
    });
    retryUrls = pagesForRetry(cited, sent);
    const retryPages = sent.filter((p) => retryUrls.includes(p.url));
    const reasons = failing.map((field) => ({ field, reason: v1.checks[field].reason ?? "failed verification" }));

    let input2: Record<string, unknown> | null = null;
    try {
      const second = await deps.llm.call(
        { callType: "extract_retry", leadId: deps.leadId },
        params(deps, tool, retryMessage(retryPages, reasons), MAX_OUTPUT_TOKENS.extract_retry),
      );
      retriesUsed = 1;
      input2 = toolInput(second.message);
      modelFlaggedInjection ||= input2.suspected_prompt_injection === true;
    } catch (err) {
      if (!(err instanceof BudgetExceededError)) throw err;
      budgetExceeded = true;
    }

    const v2 = input2 ? verifyExtraction(input2, new Map(retryPages.map((p) => [p.url, p.text])), failing) : null;
    for (const field of failing) {
      const firstReason = v1.checks[field].reason;
      const check = v2?.checks[field];
      if (v2 && check?.status === "verified") {
        (facts as Record<string, unknown>)[field] = v2.facts[field];
        fields[field] = { ...check, retried: true, firstReason };
        continue;
      }
      (facts as Record<string, unknown>)[field] = NOT_FOUND;
      const second = !v2 ? "retry skipped: lead token budget reached" : check?.status === "not_found" ? "retry returned NOT_FOUND" : `retry: ${check?.reason}`;
      fields[field] = { status: "rejected", reason: second, answer: check?.answer ?? v1.checks[field].answer, retried: !!v2, firstReason };
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
