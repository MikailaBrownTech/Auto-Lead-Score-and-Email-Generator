import type Anthropic from "@anthropic-ai/sdk";
import {
  containsPhrase,
  countWords,
  isFound,
  PERSONAL_LINE_TOOL_NAME,
  PersonalLineOutputSchema,
  type Dossier,
  type EvidenceConfig,
  type StyleConfig,
} from "@clearpath/shared";
import { fallbackLine } from "../docs/templates";
import { keywordIn, personalTermIn, valueInText, wordsOf } from "../extract/verify";
import { lastRunId } from "../llm/client";
import { MAX_OUTPUT_TOKENS } from "../llm/limits";
import { bodySentences, findAbsenceClaims, INSURER_RE, QUANTIFIER_RE, REGULATORY_SENTENCE_RE } from "../validators/email";
import { leadSegment, type PersonalLine } from "./assemble";
import type { WriteDeps } from "./generate";
import { firmShort, leadFields } from "./merge";
import { personalLineMessage, personalLineTool, type LineRequest } from "./prompt";
import { detectGrounding, verifiedValues } from "./values";

/** Longest personal line (words). */
export const PERSONAL_LINE_MAX_WORDS = 30;

const LINK_OR_ADDRESS = /https?:\/\/|www\.|@|\b[a-z0-9-]+\.(?:com|net|org|io|co|us)\b|\$/i;
const DNS_WORDS = /\b(dmarc|spf|dkim|mx|dns|domain|email security|email authentication)\b/i;
const CAPS_WORD_RE = /\b[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*\b/g;

export interface LineCheckContext {
  dossier: Dossier;
  /** verifiedValues(...).prospect_facts */
  values: Record<string, unknown>;
  style: StyleConfig;
  evidence: EvidenceConfig;
}

/**
 * Code checks for the model's {{personal_line}}: one sentence, at most 30 words, one or two verified
 * values (firm, city, services) and nothing else about the firm, no regulatory or insurer statement,
 * no evaluation of the firm, no personal details, no people, numbers, links, or DNS remarks.
 * Returns the problems in plain words (empty = usable).
 */
export function validatePersonalLine(line: string, ctx: LineCheckContext): string[] {
  const problems: string[] = [];
  const t = line.trim();
  const { style, dossier: d, values } = ctx;
  const firm = typeof values.firm_name === "string" ? values.firm_name : null;
  const withoutFirm = firm ? t.split(firm).join(" ").split(firmShort(firm)).join(" ") : t;

  if (!t) return ["empty"];
  if (/\r|\n/.test(t)) problems.push("more than one line");
  if (/[?]/.test(t)) problems.push("contains a question (email 1 already has its one question)");
  if (/!/.test(t)) problems.push("contains an exclamation mark");
  if (!/\.$/.test(t)) problems.push("does not end with a period");
  // The firm's name is left out when counting: "M.E. & Associates" is not two sentences.
  if (bodySentences(withoutFirm).length !== 1) problems.push("is not exactly one sentence");
  const words = countWords(t);
  if (words > PERSONAL_LINE_MAX_WORDS) problems.push(`${words} words (max ${PERSONAL_LINE_MAX_WORDS})`);
  if (/^(hi|hello|dear)\b/i.test(t)) problems.push("starts with a greeting");
  if (/\{\{|\[[^\]]*\]/.test(t)) problems.push("has a placeholder");

  // Facts: one or two of firm name, city, services; nothing else about the firm.
  const loc = values.location as { city?: string; state?: string } | undefined;
  const services = (values.services as string[] | undefined) ?? [];
  const used =
    (firm && (valueInText(t, firm) || valueInText(t, firmShort(firm))) ? 1 : 0) +
    (loc?.city && valueInText(t, loc.city) ? 1 : 0) +
    services.filter((s) => valueInText(t, s)).length;
  if (used === 0) problems.push("uses none of the verified values (firm, city, services)");
  if (used > 2) problems.push(`uses ${used} values (one or two allowed)`);
  const other = detectGrounding(t, values).filter((f) => !["firm_name", "location", "services"].includes(f));
  if (other.length > 0) problems.push(`uses ${other.join(", ")} (only firm, city, and services are allowed)`);
  // Numbers only inside the firm's name or a verified service ("S-Corp (1120S)"); any other is a new fact.
  const withoutValues = services.filter((s) => valueInText(t, s)).reduce((x, s) => x.replace(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " "), withoutFirm);
  if (/\d/.test(withoutValues)) problems.push("contains a number (not one of the allowed values)");

  // No regulatory or insurer statements, no universal claims.
  // A verified service is named as written ("IRS Representation"); only the words around it are checked.
  if (REGULATORY_SENTENCE_RE.test(withoutValues)) problems.push("makes a regulatory statement");
  if (INSURER_RE.test(withoutValues)) problems.push("mentions insurers");
  if (QUANTIFIER_RE.test(t)) problems.push("uses all/every/always");

  // No evaluation of the firm, no fear or hype, no absence claims, no proof, no company names.
  for (const term of [...style.evaluative_terms, ...style.banned_phrases]) {
    if (containsPhrase(withoutFirm, term)) problems.push(`evaluates or hypes ("${term}")`);
  }
  if (findAbsenceClaims(t, style).length > 0) problems.push("says or implies the firm lacks a plan or safeguard");
  for (const p of style.proof_patterns) if (containsPhrase(t, p)) problems.push(`claims proof ("${p}")`);
  if (/\bclear\s*path\b/i.test(t)) problems.push("names the sender's company");

  // No personal details, people, links, addresses, or DNS remarks.
  const term = personalTermIn(withoutValues, ctx.evidence.personal_terms);
  if (term) problems.push(`personal detail ("${term}")`);
  const firmWords = new Set(wordsOf(firm ?? "").split(" "));
  const names = [...d.people.map((p) => p.name), ...(isFound(d.decision_maker) ? [d.decision_maker.value.name] : [])];
  const nameWords = names.flatMap((n) => wordsOf(n).split(" ")).filter((w) => w.length >= 3 && !firmWords.has(w));
  const lineWords = new Set(wordsOf(t).split(" "));
  if (nameWords.some((w) => lineWords.has(w))) problems.push("names a person");
  if (LINK_OR_ADDRESS.test(withoutFirm)) problems.push("contains a link, address, or money figure");
  if (DNS_WORDS.test(t)) problems.push("makes a DNS or email-security remark");
  const allowed = new Set(style.allowed_acronyms);
  const caps = [...new Set(withoutFirm.match(CAPS_WORD_RE) ?? [])].filter((w) => !allowed.has(w));
  if (caps.length > 0) problems.push(`ALL CAPS words: ${caps.join(", ")}`);
  return [...new Set(problems)];
}

export interface LineResult {
  line: PersonalLine;
  /** The model's subject pick (only when its line was used). */
  subject: "A" | "B" | null;
  /** Why the fallback was used, in plain words; null when the model's line was used. Never an error. */
  note: string | null;
  /** The model's line when it was rejected (for the report), else null. */
  rejected: string | null;
  called: boolean;
}

/**
 * The one service the model may name, chosen by code: the first verified service that names the
 * lead's firm type (docs/06 firm_type_keywords), else the first one found. Null without services.
 */
export function chosenService(d: Dossier, values: Record<string, unknown>, evidence: EvidenceConfig): string | null {
  const services = (values.services as string[] | undefined) ?? [];
  const type = d.target_industry_fit.qualifying_type ?? (isFound(d.firm_type) ? d.firm_type.value.primary : null);
  const keywords = type && type !== "other" ? evidence.firm_type_keywords[type] : [];
  return services.find((s) => keywords.some((k) => keywordIn(s, k))) ?? services[0] ?? null;
}

/** The model's input: verified values only (firm, type, city/state, one code-chosen service) and the copy around the line. */
export function lineRequest(d: Dossier, deps: Pick<WriteDeps, "offer" | "evidence" | "templates">, firstName: string | null): LineRequest {
  const values = verifiedValues(d, deps.offer, deps.evidence).prospect_facts;
  const segment = leadSegment(d, deps.templates);
  const lead = leadFields(d);
  const e1 = deps.templates.emails.get(1)!;
  const fillLead = (s: string) => s.split("{{firm}}").join(lead.firm ?? "your firm").split("{{firm_short}}").join(lead.firm_short ?? "your firm").split("{{city}}").join(lead.city ?? "your area");
  const at = e1.paragraphs.findIndex((p) => p.includes("{{personal_line}}"));
  const loc = values.location as { city?: string; state?: string } | undefined;
  return {
    facts: {
      firm_name: (values.firm_name as string | undefined) ?? null,
      firm_type: isFound(d.firm_type) ? d.firm_type.value.primary : null,
      city: loc?.city ?? null,
      state: loc?.state ?? null,
      service: chosenService(d, values, deps.evidence),
    },
    // Only a real theme ("emphasize SSNs, bank details ..."); "default sequence" is a note for the founder.
    theme: /emphasi[sz]e/i.test(deps.templates.segments[segment]?.notes ?? "") ? deps.templates.segments[segment]!.notes : "",
    before: firstName ? `Hi ${firstName},` : e1.roleLine ? fillLead(e1.roleLine) : "",
    after: fillLead(e1.paragraphs[at + 1] ?? ""),
    subjects: { A: fillLead(e1.subject_a ?? ""), B: fillLead(e1.subject_b ?? "") },
  };
}

/** The personal-line request as sent (also used to record generations for tests). */
export function personalLineParams(deps: Pick<WriteDeps, "modelLine" | "lineSystem">, text: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: deps.modelLine,
    max_tokens: MAX_OUTPUT_TOKENS.personal_line,
    // Static prefix first (tool, then system), cacheable; the lead's values go in the user message.
    tools: [personalLineTool()],
    tool_choice: { type: "tool", name: PERSONAL_LINE_TOOL_NAME },
    system: [{ type: "text", text: deps.lineSystem, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
  };
}

/**
 * {{personal_line}} for email 1: one small model call, checked by code. Any failure the code can
 * repair (no call allowed, spend cap, budget, API error, unreadable answer, a line that fails the
 * checks) falls back to the docs/09 line for the firm type, with a plain note. Never throws for those.
 */
export async function writePersonalLine(leadId: string, d: Dossier, deps: WriteDeps, opts: { call: boolean; firstName: string | null }): Promise<LineResult> {
  const fallback = (note: string, rejected: string | null = null, called = true): LineResult => ({
    line: { text: fallbackLine(leadSegment(d, deps.templates), deps.templates), source: "fallback" },
    subject: null,
    note,
    rejected,
    called,
  });
  if (!opts.call) return fallback("tier C: the docs/09 fallback line is used, with no model call", null, false);
  const values = verifiedValues(d, deps.offer, deps.evidence).prospect_facts;
  let input: unknown;
  try {
    const { message } = await deps.llm.call(
      { callType: "personal_line", leadId, budgetSinceRunId: lastRunId(deps.db) },
      personalLineParams(deps, personalLineMessage(lineRequest(d, deps, opts.firstName))),
    );
    const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === PERSONAL_LINE_TOOL_NAME);
    input = block?.input;
  } catch (err) {
    return fallback(`the model was not used (${(err as Error).message.split("\n")[0]!.slice(0, 200)}), so the docs/09 fallback line is used`);
  }
  const parsed = PersonalLineOutputSchema.safeParse(input);
  if (!parsed.success) return fallback("the model's answer could not be read, so the docs/09 fallback line is used");
  const text = parsed.data.personal_line.trim().replace(/^["“]|["”]$/g, "").trim();
  const problems = validatePersonalLine(text, { dossier: d, values, style: deps.style, evidence: deps.evidence });
  if (problems.length > 0) return fallback(`the model's line did not pass the checks (${problems.join("; ")}), so the docs/09 fallback line is used`, text);
  return { line: { text, source: "model" }, subject: parsed.data.subject ?? null, note: null, rejected: null, called: true };
}
