import {
  containsPhrase,
  countWords,
  isFound,
  normalizeText,
  type Dossier,
  type FactField,
  type OfferConfig,
  type RegulatoryFact,
  type Sequence,
  type SequenceEmail,
  type StyleConfig,
} from "@clearpath/shared";
import { SETTINGS_FIELDS } from "../docs/templates";
import { contactPlan } from "../scoring/contact";
import { firmShort, renderSettings } from "../write/merge";
import { dnsObservation } from "../write/values";

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
  /**
   * The VERIFIED docs/02 facts the writer was given. When present, any number in a regulatory
   * sentence must appear in these facts (no invented deadlines, counts, or section numbers).
   */
  verifiedFacts?: RegulatoryFact[];
  /** docs/02 approved sentences (text). When present, writer emails may state what a rule requires only through these exact sentences. */
  approvedSentences?: string[];
  /**
   * Per email, extra sentences allowed by the allowlist: the original docs/09 template text of a
   * template email the founder edited (its fixed, reviewed sentences stay allowed).
   */
  templateSentences?: Record<number, string[]>;
}

/**
 * Fields that do not count as a personal detail: addressing (greeting, firm name, type), the city or
 * state as a free contextual reference, and the code-worded DNS observation (a security observation).
 */
const ADDRESSING_FIELDS: ReadonlySet<string> = new Set(["firm_name", "firm_type", "decision_maker", "people", "location", "dns_observation"]);

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

/** A greeting line: "Hi Jane," (a firm name may hold periods). */
const GREETING_LINE_RE = /^(hi|hello|dear)\b.*,$/i;
const BULLET_RE = /^[-*•]\s+/;

/**
 * Sentences in the body, excluding a greeting line like "Hi Jane,". Each bullet line is its own item
 * (bullet lists are allowed); other lines are joined and split at sentence ends.
 */
export function bodySentences(body: string): string[] {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  while (lines.length > 0 && lines[0] === "") lines.shift();
  if (lines.length > 0 && GREETING_LINE_RE.test(lines[0]!)) lines.shift();
  const out: string[] = [];
  let prose: string[] = [];
  const flush = () => {
    out.push(...prose.join(" ").split(/(?<=[.?!])\s+/));
    prose = [];
  };
  for (const line of lines) {
    // A blank line ends a paragraph, and so a sentence (the spliced approved sentence stays whole).
    if (line === "") flush();
    else if (BULLET_RE.test(line)) {
      flush();
      out.push(line.replace(BULLET_RE, ""));
    } else prose.push(line);
  }
  flush();
  return out.map((s) => s.trim()).filter((s) => /\w/.test(s));
}

/** The full email as sent: body (settings merge fields filled), a blank line, then the docs/09 signature block. */
export function renderEmail(body: string, offer: OfferConfig, signature: string[]): string {
  return [renderSettings(body, offer).trim(), "", ...signature].join("\n").trimEnd();
}

/** Settings merge fields left as placeholders because their docs/01 value is empty: export blockers, not text errors. */
const SETTINGS_PLACEHOLDER_RE = new RegExp(`\\{\\{(?:${SETTINGS_FIELDS.join("|")})\\}\\}`, "g");

/**
 * A sentence states what a law or rule requires when it names a rule, law, or regulator, or uses an
 * obligation verb. Referring to "the requirement" (the noun) is allowed: the writer may point at the
 * approved sentence without restating it. "fine" (okay) and "WISP" (the plan's name) are not claims.
 */
export const REGULATORY_SENTENCE_RE =
  /\b(ftc|safeguards rule|glba|gramm[- ]leach|irs|efin|ptin|pub(lication)?\.?\s*4557|4557|penalt(y|ies)|fines|fined|must|required|requires|mandatory|mandated|obligated|compliance|compliant|regulations?|regulators?|regulatory|law|laws|legally|cfr)\b/i;

/**
 * Allowlist check for model-written and edited emails: every statement (not a question) that names a
 * rule, law, or regulator or uses an obligation verb must be one of the approved docs/02 sentences,
 * verbatim. Insurer remarks and quantifiers are left to the judge (lighter validators, 2026-09-24).
 */
export function unapprovedSentences(body: string, approved: string[], exempt: string[] = []): { sentence: string; code: string }[] {
  const ok = new Set(approved.map((a) => normalizeText(a).toLowerCase()));
  const out: { sentence: string; code: string }[] = [];
  for (const sentence of bodySentences(body)) {
    if (ok.has(normalizeText(sentence).toLowerCase())) continue;
    // A question asks; it does not state what a rule requires.
    if (sentence.trim().endsWith("?")) continue;
    // The firm's name and its verified services are named as written ("IRS Representation" is a service, not a claim).
    const stripped = exempt.filter(Boolean).reduce((s, x) => s.replace(new RegExp(x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), " "), sentence);
    if (REGULATORY_SENTENCE_RE.test(stripped)) out.push({ sentence, code: "unapproved_regulatory_sentence" });
  }
  return out;
}

/** Capitalized words the lead itself uses (its name, verified services and software): allowed as-is. */
function leadAcronyms(d: Dossier | undefined): string[] {
  if (!d) return [];
  const texts = [isFound(d.firm_name) ? d.firm_name.value : "", ...(isFound(d.services) ? d.services.value : []), ...(isFound(d.software_mentioned) ? d.software_mentioned.value : [])];
  const found = new Set(texts.flatMap((t) => t.match(CAPS_WORD_RE) ?? []));
  // Accounting shorthand for accounts payable/receivable is how these firms describe their own services.
  if (texts.some((t) => /accounts (payable|receivable)/i.test(t))) found.add("AP").add("AR");
  return [...found];
}

/** A sentence about the prospect: its name, or "you/your" plus the firm, team, site, security, or setup. */
const PROSPECT_RE = /\byou(?:'re| are)\b|\byour (?:firm|practice|team|office|shop|business|site|website|security|setup|systems?|data|clients?|work)\b/i;
export function aboutProspect(sentence: string, firmName: string | null): boolean {
  return PROSPECT_RE.test(sentence) || (!!firmName && (containsPhrase(sentence, firmName) || containsPhrase(sentence, firmShort(firmName))));
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
  // The firm's name (full or short) and the region are exempt from the case rule and the word limit.
  const firmName = ctx.dossier && isFound(ctx.dossier.firm_name) ? ctx.dossier.firm_name.value : null;
  const exempt = [firmName, firmName ? firmShort(firmName) : null, ctx.offer.region.trim() || null, "{{region}}"].filter((x): x is string => !!x);
  // Words of the firm's name also count as the name ("M.E. & Associates" for "M.E. & Associates Services").
  const firmWords = new Set((firmName ?? "").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)));
  const withoutFirm = exempt
    .reduce((s, x) => s.split(x).join(" "), subject)
    .replace(SETTINGS_PLACEHOLDER_RE, " ")
    .split(/(\s+)/)
    .map((w) => (firmWords.has(w.replace(/[?,:;]+$/, "")) ? " " : w))
    .join("");
  if (withoutFirm !== withoutFirm.toLowerCase()) err("subject_case", `${label} must be lowercase (firm name and region excepted)`);
  const words = countWords(withoutFirm);
  if (words > ctx.style.subject_max_words) {
    err("subject_length", `${label} has ${words} words, not counting the firm name or region (max ${ctx.style.subject_max_words})`);
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

const DNS_TERMS = /\b(dmarc|spf|dkim|mx records?|dns|email authentication|sender policy)\b/i;
const DNS_ALARM = /\b(vulnerab\w*|at[- ]risk|exposed|spoof\w*|insecure|unprotected)\b/i;

/**
 * DNS remarks (docs/01 include_dns_observation): only when the setting is on, the email is grounded
 * on dns_observation, and the lookup shows the domain has email with an evidenced DMARC finding.
 * Never alarm words, never DKIM (DKIM is caught separately).
 */
function checkDns(e: SequenceEmail, ctx: ValidationContext, issues: Issue[]): void {
  const text = [e.body, e.subject_a ?? "", e.subject_b ?? ""].join("\n");
  if (!DNS_TERMS.test(text)) return;
  const err = (code: string, message: string) => issues.push({ severity: "error", email: e.n, code, message });
  if (!ctx.offer.include_dns_observation) {
    err("dns_not_enabled", "mentions DNS/email settings but include_dns_observation is off in docs/01");
    return;
  }
  if (!e.grounding.includes("dns_observation")) err("dns_not_grounded", "mentions DNS/email settings without grounding on dns_observation");
  if (ctx.dossier && dnsObservation(ctx.dossier, ctx.offer) === null) {
    err("dns_not_evidenced", "mentions DNS/email settings, but the domain has no MX records or no evidenced DMARC finding");
  }
  for (const sentence of bodySentences(text)) {
    if (DNS_TERMS.test(sentence) && DNS_ALARM.test(sentence)) err("dns_alarm", `DNS remark must be hedged, never alarming: "${sentence}"`);
  }
}

const REGULATORY_TERMS = /\b(ftc|irs|safeguards|publication|pub\.?|rule|regulation|requires?|required|cfr|notify|notification)\b/i;

/**
 * Numbers in regulatory sentences must come from the VERIFIED docs/02 facts ("30 days", "4557").
 * List markers ("1. ") are ignored. Catches invented deadlines, counts, and citations.
 */
export function unverifiedRegulatoryNumbers(text: string, facts: RegulatoryFact[]): { sentence: string; numbers: string[] }[] {
  const allowed = new Set(facts.flatMap((f) => f.text.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, "")));
  const out: { sentence: string; numbers: string[] }[] = [];
  for (const sentence of bodySentences(text)) {
    if (!REGULATORY_TERMS.test(sentence)) continue;
    const stripped = sentence.replace(/(^|\s)\d{1,2}\.(?=\s|$)/g, " ");
    const numbers = (stripped.match(/\d[\d,]*/g) ?? []).map((n) => n.replace(/,/g, "")).filter((n) => !allowed.has(n));
    if (numbers.length > 0) out.push({ sentence, numbers });
  }
  return out;
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
    // The negation has to govern the plan term: within the few words before it ("you don't have a
    // written plan", "operating without a WISP"), not anywhere in the sentence ("a written plan, no cost").
    const lower = s.toLowerCase();
    for (const t of plan_terms) {
      const re = new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      for (const m of lower.matchAll(re)) {
        const before = lower.slice(0, m.index).split(/\s+/).filter(Boolean).slice(-6).join(" ");
        if (negations.some((n) => containsPhrase(before, n))) return true;
      }
    }
    return false;
  });
}

function checkEmail(raw: SequenceEmail, ctx: ValidationContext, issues: Issue[]): void {
  const { style, offer } = ctx;
  const n = raw.n;
  // Checked as it will be sent: settings merge fields filled from docs/01. An empty setting stays a
  // placeholder, which blocks export (exportBlockers), not the text.
  const e: SequenceEmail = {
    ...raw,
    body: renderSettings(raw.body, offer),
    subject_a: raw.subject_a ? renderSettings(raw.subject_a, offer) : null,
    subject_b: raw.subject_b ? renderSettings(raw.subject_b, offer) : null,
  };
  const err = (code: string, message: string) => issues.push({ severity: "error", email: n, code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", email: n, code, message });

  if (e.send_day !== style.send_days[n - 1]) {
    err("send_day", `send day ${e.send_day} should be ${style.send_days[n - 1]}`);
  }

  const limit = style.word_limits[String(n) as "1"]!;
  const words = countWords(e.body);
  if (words > limit) err("word_count", `${words} words (max ${limit})`);

  // The firm's own name (full or short) is exempt from the text checks, and capitalized words from its
  // name or verified values ("RBV", "AP/AR") are not ALL CAPS shouting.
  const firmName = ctx.dossier && isFound(ctx.dossier.firm_name) ? ctx.dossier.firm_name.value : null;
  const bodyText = (firmName ? [firmName, firmShort(firmName)] : []).reduce((s, x) => s.split(x).join(" "), e.body);
  checkText(n, "body", bodyText.replace(SETTINGS_PLACEHOLDER_RE, " "), { ...style, allowed_acronyms: [...style.allowed_acronyms, ...leadAcronyms(ctx.dossier)] }, issues);

  const links = findLinks(e.body);
  if (links.length > style.max_links_per_email) {
    err("link_count", `${links.length} links (max ${style.max_links_per_email})`);
  }
  const booking = offer.booking_link.trim() ? canonicalLink(offer.booking_link) : null;
  for (const link of links) {
    if (canonicalLink(link) !== booking) err("link_not_allowed", `link ${link} is not the booking_link in docs/01`);
  }
  if (n === 1 && links.length > 0) warn("link_in_email_1", "email 1 has a link (style guide: none in email 1 if possible)");

  // Untouched docs/09 copy is the founder's own reviewed wording ("I'm launching ... so I'm working with a
  // small first group"); proof and traction checks apply to model-written and edited text.
  if (!e.template || e.edited) checkProof(n, e.body, ctx, issues);
  checkDns(e, ctx, issues);
  // Questions per email and details per email are prompt guidance, not rules (natural writing sometimes needs two).
  // The company name comes only from docs/01 (the signature); a variant in the text is invented.
  // Links are skipped: the booking link may carry the company's name in its path.
  for (const m of e.body.replace(URL_RE, " ").matchAll(/\bclear\s*path(?:\s+(?:it|secure|security|technologies|solutions))?\b/gi)) {
    if (!ctx.offer.company_name || normalizeText(m[0]) !== normalizeText(ctx.offer.company_name)) {
      err("company_name", `names the company as "${m[0]}"; only docs/01 company_name ("${ctx.offer.company_name}") may be used`);
    }
  }
  // Model-written or hand-edited text: a statement of what a law or rule requires must be the exact
  // approved docs/02 sentence (spliced in by code). One other such sentence fails the email.
  if ((!e.template || e.edited) && ctx.approvedSentences) {
    const services = ctx.dossier && isFound(ctx.dossier.services) ? ctx.dossier.services.value : [];
    for (const hit of unapprovedSentences(e.body, [...ctx.approvedSentences, ...(ctx.templateSentences?.[n] ?? [])], [firmName ?? "", ...services])) {
      err(hit.code, `states a regulatory point that is not the approved docs/02 sentence (refer to "the requirement" or ask instead): "${hit.sentence}"`);
    }
    // No evaluation of the prospect: an evaluative word in a sentence about the firm.
    for (const sentence of bodySentences(e.body)) {
      if (!aboutProspect(sentence, firmName)) continue;
      const term = style.evaluative_terms.find((t) => containsPhrase(firmName ? sentence.split(firmName).join(" ") : sentence, t));
      if (term) err("evaluates_prospect", `evaluates the prospect ("${term}"); describe or ask instead: "${sentence}"`);
    }
  }
  if (ctx.verifiedFacts) {
    for (const hit of unverifiedRegulatoryNumbers(e.body, ctx.verifiedFacts)) {
      err("unverified_regulatory_number", `regulatory sentence uses ${hit.numbers.join(", ")}, not in the VERIFIED docs/02 facts: "${hit.sentence}"`);
    }
  }

  for (const text of [e.body, e.subject_a ?? "", e.subject_b ?? ""]) {
    for (const sentence of findAbsenceClaims(text, style)) {
      err("absence_claim", `claims the firm lacks a WISP or plan, which we cannot know: "${sentence}"`);
    }
  }

  if (e.subject_a) checkSubject(n, "A", e.subject_a, ctx, issues);
  if (e.subject_b) checkSubject(n, "B", e.subject_b, ctx, issues);

  if (ctx.dossier) {
    for (const f of e.grounding) {
      if (f === "dns_observation") {
        if (dnsObservation(ctx.dossier, ctx.offer) === null) err("grounding_not_found", "grounded on dns_observation, which is off or not evidenced");
        continue;
      }
      const value = (ctx.dossier as Record<string, unknown>)[f];
      if (value === undefined || !isFound(value) || (Array.isArray(value) && value.length === 0)) {
        err("grounding_not_found", `grounded on ${f}, which is NOT_FOUND`);
      }
    }
    // Greet by name only when the public address belongs to the decision maker (docs/09 greeting rules);
    // otherwise email 1 opens with the role-based line and no name.
    const d = ctx.dossier;
    const plan = contactPlan(d);
    const lines = e.body.trim().split(/\r?\n/);
    const firstLine = lines[0]!.trim();
    const greeted = /^(?:hi|hello|dear)\s+([^\s,]+)\s*,/i.exec(firstLine)?.[1] ?? null;
    if (greeted && (plan.greetFirstName === null || greeted.toLowerCase() !== plan.greetFirstName.toLowerCase())) {
      err("greeting_contact_mismatch", `greets "${greeted}" but ${plan.reason}; open with the role-based line instead`);
    }
    // Without a name, email 1 must still be about this firm: its name (full or short) or one verified
    // detail outside a greeting line, so it is never a generic template.
    if (n === 1 && !greeted) {
      const rest = [(GREETING_LINE_RE.test(firstLine) ? lines.slice(1) : lines).join(" "), e.subject_a ?? "", e.subject_b ?? ""].join(" ");
      const namesFirm = isFound(d.firm_name) && (containsPhrase(rest, d.firm_name.value) || containsPhrase(rest, firmShort(d.firm_name.value)));
      const hasDetail = e.grounding.some((f) => !ADDRESSING_FIELDS.has(f));
      if (!namesFirm && !hasDetail) {
        err("generic_email_1", "email 1 has a neutral greeting, so it must name the firm or use one verified detail (it reads as a generic template otherwise)");
      }
    }
  }
  // The docs/09 fixed copy uses no dossier details (legacy sequences carry a personal line that may).
  if (e.template && !e.edited && !e.personal_line && e.grounding.length > 0) {
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

  const o = ctx.offer;
  if ([o.opt_out_line, o.physical_address, o.sender_title, o.company_name, o.company_website, o.founding_client_offer ?? "", o.booking_link, o.region].some((v) => v.trim() === "")) {
    issues.push({
      severity: "warning",
      email: null,
      code: "footer_incomplete",
      message:
        "a setting is empty in docs/01 (signature, footer, founding_client_offer, booking_link, or region); the preview shows its {{placeholder}} and export is blocked until all are set",
    });
  }

  return { pass: issues.every((i) => i.severity !== "error"), issues };
}
