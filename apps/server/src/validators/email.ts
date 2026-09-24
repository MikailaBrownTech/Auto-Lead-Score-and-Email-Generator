import {
  containsPhrase,
  countWords,
  isFound,
  normalizeText,
  type Dossier,
  type FactField,
  type OfferConfig,
  type Sequence,
  type SequenceEmail,
  type StyleConfig,
} from "@clearpath/shared";
import { contactPlan } from "../scoring/contact";

export { containsPhrase };

export type Severity = "error" | "warning";

export interface Issue {
  severity: Severity;
  /** Email number, or null for sequence-level issues. */
  email: number | null;
  code: string;
  message: string;
}

export interface ValidationResult {
  /** True when there are no errors. Warnings do not block approval. */
  pass: boolean;
  issues: Issue[];
}

export interface ValidationContext {
  style: StyleConfig;
  offer: OfferConfig;
  /** When given, grounding fields are checked against it. */
  dossier?: Dossier;
}

/** Dossier fields used for addressing (greeting, firm name) that do not count as a personal detail. */
const ADDRESSING_FIELDS: ReadonlySet<string> = new Set(["firm_name", "firm_type", "decision_maker", "people"]);

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|\[[^\]]*\]/;
const EMAIL_ADDR_RE = /[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
const BARE_DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|us|biz|info|app|ai)\b(?:\/[^\s<>()]*)?/gi;
const CAPS_WORD_RE = /\b[A-Z][A-Z0-9]*[A-Z][A-Z0-9]*\b/g;

function canonicalLink(link: string): string {
  return link
    .replace(/[.,;:!?)"']+$/, "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

export function findLinks(text: string): string[] {
  const withoutEmails = text.replace(EMAIL_ADDR_RE, " ");
  const urls = withoutEmails.match(URL_RE) ?? [];
  const rest = withoutEmails.replace(URL_RE, " ");
  const bare = rest.match(BARE_DOMAIN_RE) ?? [];
  return [...urls, ...bare].map((l) => l.replace(/[.,;:!?)"']+$/, ""));
}

/** Sentences in the body, excluding a greeting line like "Hi Jane," or "Hi,". */
export function bodySentences(body: string): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && /^(hi|hello|dear)\b[^.?!]*,$/i.test(lines[0]!)) lines.shift();
  return lines
    .join(" ")
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => /\w/.test(s));
}

/** The full email as sent: body, sign-off, opt-out line, address. */
export function renderEmail(body: string, offer: OfferConfig): string {
  return [body.trim(), "", offer.sender_name, offer.opt_out_line, offer.physical_address].join("\n").trimEnd();
}

function checkText(
  n: number,
  label: string,
  text: string,
  style: StyleConfig,
  issues: Issue[],
): void {
  const err = (code: string, message: string) => issues.push({ severity: "error", email: n, code, message });
  for (const phrase of style.banned_phrases) {
    if (containsPhrase(text, phrase)) err("banned_phrase", `${label} contains banned phrase "${phrase}"`);
  }
  if (text.includes("!")) err("exclamation", `${label} contains an exclamation mark`);
  if (EMOJI_RE.test(text)) err("emoji", `${label} contains an emoji`);
  const allowed = new Set(style.allowed_acronyms);
  const caps = [...new Set(text.match(CAPS_WORD_RE) ?? [])].filter((w) => !allowed.has(w));
  if (caps.length > 0) err("all_caps", `${label} has ALL CAPS words not in allowed_acronyms: ${caps.join(", ")}`);
  if (PLACEHOLDER_RE.test(text)) err("placeholder", `${label} has an unfilled placeholder: ${PLACEHOLDER_RE.exec(text)![0]}`);
  if (/\bDKIM\b/i.test(text)) err("dkim_claim", `${label} mentions DKIM; DKIM status is never checked or claimed`);
  // Never quote penalty amounts (fear) or prices (docs/01: do not quote pricing).
  if (/\$\s?\d|\b\d[\d,.]*\s?(dollars|usd)\b/i.test(text)) {
    err("dollar_amount", `${label} contains a dollar amount; penalty figures and prices are never used`);
  }
  if (/\b(civil )?penalt(y|ies)\b|\bper violation\b/i.test(text)) {
    err("penalty_language", `${label} mentions penalties; penalty facts are never used in emails`);
  }
}

function checkSubject(
  n: number,
  which: string,
  subject: string,
  ctx: ValidationContext,
  issues: Issue[],
): void {
  const err = (code: string, message: string) => issues.push({ severity: "error", email: n, code, message });
  const label = `subject ${which}`;
  const firmName = ctx.dossier && isFound(ctx.dossier.firm_name) ? ctx.dossier.firm_name.value : null;
  const withoutFirm = firmName ? subject.split(firmName).join("") : subject;
  if (withoutFirm !== withoutFirm.toLowerCase()) err("subject_case", `${label} must be lowercase (firm name excepted)`);
  if (countWords(subject) > ctx.style.subject_max_words) {
    err("subject_length", `${label} has ${countWords(subject)} words (max ${ctx.style.subject_max_words})`);
  }
  if (/^\s*(re|fwd?|fw)\s*:/i.test(subject)) err("fake_reply", `${label} starts with Re:/Fwd:`);
  if (findLinks(subject).length > 0) err("subject_link", `${label} contains a link`);
  checkText(n, label, withoutFirm, ctx.style, issues);
}

function checkProof(n: number, body: string, ctx: ValidationContext, issues: Issue[]): void {
  const approved = ctx.offer.approved_proof;
  for (const sentence of bodySentences(body)) {
    const pattern = ctx.style.proof_patterns.find((p) => containsPhrase(sentence, p));
    if (!pattern) continue;
    const backed = approved.some((item) => normalizeText(sentence).toLowerCase().includes(normalizeText(item).toLowerCase()));
    if (!backed) {
      issues.push({
        severity: "error",
        email: n,
        code: "unapproved_proof",
        message:
          approved.length === 0
            ? `claims proof ("${pattern}") but approved_proof in docs/01 is empty: "${sentence}"`
            : `claims proof ("${pattern}") not matching any approved_proof item: "${sentence}"`,
      });
    }
  }
}

/**
 * Blocks statements that the firm lacks a WISP or plan ("you don't have a written security plan").
 * We can only observe that a site does not mention one, which is not the same thing. Questions and
 * conditionals ("if you don't have a plan yet, ...") are allowed.
 */
export function findAbsenceClaims(text: string, style: StyleConfig): string[] {
  const { negations, plan_terms } = style.absence_claims;
  return bodySentences(text).filter((sentence) => {
    const s = normalizeText(sentence);
    if (s.endsWith("?") || /^(if|whether)\b/i.test(s)) return false;
    return negations.some((n) => containsPhrase(s, n)) && plan_terms.some((t) => containsPhrase(s, t));
  });
}

function checkEmail(e: SequenceEmail, ctx: ValidationContext, issues: Issue[]): void {
  const { style, offer } = ctx;
  const n = e.n;
  const err = (code: string, message: string) => issues.push({ severity: "error", email: n, code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", email: n, code, message });

  if (e.send_day !== style.send_days[n - 1]) {
    err("send_day", `send day ${e.send_day} should be ${style.send_days[n - 1]}`);
  }

  if (n <= 4) {
    const limit = style.word_limits[String(n) as "1"]!;
    const words = countWords(e.body);
    if (words > limit) err("word_count", `${words} words (max ${limit})`);
  } else {
    const count = bodySentences(e.body).length;
    const { min, max } = style.breakup_sentences;
    if (count < min || count > max) err("sentence_count", `break-up email has ${count} sentences (needs ${min}-${max})`);
  }

  checkText(n, "body", e.body, style, issues);

  const links = findLinks(e.body);
  if (links.length > style.max_links_per_email) {
    err("link_count", `${links.length} links (max ${style.max_links_per_email})`);
  }
  const cta = canonicalLink(offer.cta_url);
  for (const link of links) {
    if (canonicalLink(link) !== cta) err("link_not_allowed", `link ${link} is not the CTA link in docs/01`);
  }
  if (n === 1 && links.length > 0) warn("link_in_email_1", "email 1 has a link (style guide: none in email 1 if possible)");
  if (n === 1 && (e.body.match(/\?/g) ?? []).length !== 1) {
    warn("email_1_question", "email 1 should end on exactly one question");
  }

  checkProof(n, e.body, ctx, issues);

  for (const text of [e.body, e.subject_a ?? "", e.subject_b ?? ""]) {
    for (const sentence of findAbsenceClaims(text, style)) {
      err("absence_claim", `claims the firm lacks a WISP or plan, which we cannot know: "${sentence}"`);
    }
  }

  if (e.subject_a) checkSubject(n, "A", e.subject_a, ctx, issues);
  if (e.subject_b) checkSubject(n, "B", e.subject_b, ctx, issues);

  const details = e.grounding.filter((f) => !ADDRESSING_FIELDS.has(f));
  if (details.length > style.max_personal_details_per_email) {
    err(
      "too_many_details",
      `uses ${details.length} personal details (${details.join(", ")}); max ${style.max_personal_details_per_email}`,
    );
  }
  if (ctx.dossier) {
    for (const f of e.grounding) {
      const value = (ctx.dossier as Record<string, unknown>)[f];
      if (value === undefined || !isFound(value) || (Array.isArray(value) && value.length === 0)) {
        err("grounding_not_found", `grounded on ${f}, which is NOT_FOUND`);
      }
    }
    // Greet by name only when the public address belongs to the decision maker (docs/03 + contact rule).
    const greeted = /^(?:hi|hello|dear)\s+([^\s,]+)\s*,/i.exec(e.body.trim())?.[1] ?? null;
    if (greeted) {
      const plan = contactPlan(ctx.dossier);
      if (plan.greetFirstName === null || greeted.toLowerCase() !== plan.greetFirstName.toLowerCase()) {
        err("greeting_contact_mismatch", `greets "${greeted}" but ${plan.reason}; use "${plan.greeting}"`);
      }
    }
  }
  if (e.template && e.grounding.length > 0) {
    err("template_grounding", "template emails must not use dossier details");
  }
}

/**
 * Deterministic checks from docs/03 and docs/01. Approval is blocked while any error remains;
 * the LLM judge (Milestone 4) runs in addition to these, not instead of them.
 */
export function validateSequence(seq: Sequence, ctx: ValidationContext): ValidationResult {
  const issues: Issue[] = [];
  for (const e of seq.emails) checkEmail(e, ctx, issues);

  const angles = ctx.style.firm_type_angles;
  const types = ctx.dossier && isFound(ctx.dossier.firm_type) ? [ctx.dossier.firm_type.value.primary, ...ctx.dossier.firm_type.value.secondary] : null;
  const firmType = types ? types.join("/") : null;
  const allowedAngles = types ? types.flatMap((t) => angles[t]) : Object.values(angles).flat();
  if (!allowedAngles?.includes(seq.angle)) {
    issues.push({
      severity: "error",
      email: null,
      code: "angle",
      message: `angle ${seq.angle} is not in the docs/03 list${firmType ? ` for ${firmType}` : ""}`,
    });
  }

  seq.emails.forEach((e) => {
    const mustBeTemplate = seq.tier === "C" || (seq.tier === "B" && e.n >= 3);
    if (mustBeTemplate && !e.template) {
      issues.push({
        severity: "error",
        email: e.n,
        code: "tier_gating",
        message: `tier ${seq.tier} email ${e.n} must come from the templates`,
      });
    }
  });

  if (ctx.offer.opt_out_line === "" || ctx.offer.physical_address === "") {
    issues.push({
      severity: "warning",
      email: null,
      code: "footer_incomplete",
      message: "opt_out_line or physical_address is empty in docs/01; export is blocked until both are set",
    });
  }

  return { pass: issues.every((i) => i.severity !== "error"), issues };
}
