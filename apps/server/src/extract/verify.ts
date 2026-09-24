import {
  containsPhrase,
  ExtractedFactsSchema,
  FACT_FIELDS,
  NOT_FOUND,
  normalizeText,
  type EvidenceConfig,
  type EvidenceRef,
  type ExtractedFacts,
  type FactField,
  type PageKind,
} from "@clearpath/shared";

export type FieldStatus = "verified" | "not_found" | "rejected";

/**
 * Why a field failed. Only the fixable kinds are retried: the model can pick a better quote or
 * page. Format failures (wrong type, bad enum, invalid email) are not retried.
 */
export type FailureKind = "format" | "missing" | "url_not_sent" | "quote_not_found" | "quote_too_long" | "support_mismatch" | "personal_details";
export const FIXABLE_FAILURES: ReadonlySet<FailureKind> = new Set(["url_not_sent", "quote_not_found", "quote_too_long", "support_mismatch", "personal_details"]);

/** A schema failure caused only by quote length is fixable (the model can pick a shorter span). */
function formatKind(issues: { path: (string | number)[]; message: string }[]): FailureKind {
  return issues.length > 0 && issues.every((i) => i.path[i.path.length - 1] === "evidence_quote" && /15 words/.test(i.message)) ? "quote_too_long" : "format";
}

export interface FieldCheck {
  status: FieldStatus;
  kind?: FailureKind;
  /** Why a field was rejected (shown in the retry request and in failures). */
  reason?: string;
  /** Items or quotes dropped from a list field that otherwise passed. */
  notes?: string[];
  /** A list field that passed but lost quotes or items to fixable failures; it gets the targeted retry too. */
  partial?: boolean;
  /** The model's answer as given, for reporting. */
  answer?: unknown;
}

export interface Verification {
  facts: ExtractedFacts;
  checks: Record<FactField, FieldCheck>;
}

export interface SentPageInfo {
  text: string;
  title: string;
}

export interface VerifyContext {
  pages: Map<string, SentPageInfo>;
  evidence: EvidenceConfig;
}

/** Case-insensitive, whitespace- and quote-normalized containment. */
export function textContains(haystack: string, needle: string): boolean {
  const n = normalizeText(needle).toLowerCase();
  return n.length > 0 && normalizeText(haystack).toLowerCase().includes(n);
}

function stripEdgePunctuation(q: string): string {
  return q.trim().replace(/^["'“‘(]+/, "").replace(/["'”’)]+$/, "").trim();
}

/** The quote as given, or with surrounding quote marks and trailing sentence punctuation removed. */
export function quoteInText(pageText: string, quote: string): boolean {
  if (/\.\.\.|…/.test(quote)) return false; // an ellipsis means it is not verbatim
  const bare = stripEdgePunctuation(quote);
  return textContains(pageText, quote) || textContains(pageText, bare) || textContains(pageText, bare.replace(/[.,;:]+$/, ""));
}

/** Lowercase words only ("&" -> "and"), for comparing names and values with quotes. */
export function wordsOf(s: string): string {
  return normalizeText(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Whole-word containment after wordsOf normalization. */
export function valueInText(text: string, value: string): boolean {
  const v = wordsOf(value);
  return v.length > 0 && ` ${wordsOf(text)} `.includes(` ${v} `);
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

const LIST_STOPWORDS = new Set(["and", "the", "for", "with", "our", "your", "services", "service", "solutions", "support", "help"]);

/** A list item is supported when every significant word of it appears in the quotes. */
export function itemSupported(item: string, quotesText: string): boolean {
  const words = wordsOf(item).split(" ").filter((w) => w.length >= 3 && !LIST_STOPWORDS.has(w));
  const hay = ` ${wordsOf(quotesText)} `;
  if (words.length === 0) return valueInText(quotesText, item);
  return words.every((w) => hay.includes(` ${w} `));
}

/** The first personal term a quote contains (docs/06 personal_terms), if any. */
export function personalTermIn(quote: string, terms: string[]): string | null {
  return terms.find((t) => containsPhrase(quote, t)) ?? null;
}

interface Failure {
  kind: FailureKind;
  reason: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks one evidence reference: cited page was sent, quote is verbatim, quote has no personal
 * details. Names in `ignore` (the firm's own name, a person's own name) are not scanned for personal
 * terms, so "Godfrey & Sons CPAs" is fine while "a mother to 2 boys" is not.
 */
function checkRef(ref: EvidenceRef, ctx: VerifyContext, ignore: string[] = []): Failure | null {
  const page = ctx.pages.get(ref.evidence_url);
  if (!page) return { kind: "url_not_sent", reason: `evidence_url ${ref.evidence_url} is not one of the pages provided` };
  if (!quoteInText(page.text, ref.evidence_quote)) {
    return { kind: "quote_not_found", reason: "evidence_quote was not found word for word in that page's text (one contiguous span; split, don't stitch)" };
  }
  const scanned = ignore.filter(Boolean).reduce((q, name) => q.replace(new RegExp(escapeRegex(name), "gi"), " "), ref.evidence_quote);
  const term = personalTermIn(scanned, ctx.evidence.personal_terms);
  if (term) return { kind: "personal_details", reason: `evidence_quote contains a personal detail ("${term}"); choose a professional quote` };
  return null;
}

/** Field-specific check that the value itself is in its own quote (or, for firm_name, the page title). */
function supportProblem(field: FactField, value: unknown, ref: EvidenceRef, ctx: VerifyContext): string | null {
  const quote = ref.evidence_quote;
  switch (field) {
    case "firm_name": {
      const name = value as string;
      const title = ctx.pages.get(ref.evidence_url)?.title ?? "";
      return valueInText(quote, name) || valueInText(title, name) ? null : `the name "${name}" is not in its quote or the page title`;
    }
    case "firm_type": {
      const primary = (value as { primary: string }).primary;
      if (primary === "other") return null;
      const keywords = ctx.evidence.firm_type_keywords[primary as keyof EvidenceConfig["firm_type_keywords"]] ?? [];
      return keywords.some((k) => containsPhrase(quote, k)) ? null : `the quote has no ${primary} keyword (docs/06 firm_type_keywords)`;
    }
    case "location": {
      const city = (value as { city: string | null }).city;
      return city === null || valueInText(quote, city) ? null : `the city "${city}" is not in its quote`;
    }
    case "size_signal": {
      const n = (value as { staff_count: number | null }).staff_count;
      if (n === null) return null;
      const asWord = NUMBER_WORDS[n];
      return digits(quote).includes(String(n)) || (asWord !== undefined && valueInText(quote, asWord)) ? null : `the staff count ${n} is not in its quote`;
    }
    case "public_contact_email": {
      const v = value as { address: string; owner_name: string | null };
      return textContains(quote, v.address) ? null : `the address ${v.address} is not in its quote`;
    }
    case "personal_email_domain_on_site":
      return textContains(quote, value as string) ? null : `the address ${String(value)} is not in its quote`;
    case "phone_or_contact_form": {
      const phone = (value as { phone: string | null }).phone;
      if (phone && digits(phone).length >= 7 && !digits(quote).includes(digits(phone))) return `the phone number ${phone} is not in its quote`;
      return null;
    }
    default:
      return null;
  }
}

function reject(checks: Record<string, FieldCheck>, field: FactField, f: Failure, answer: unknown, notes?: string[]): void {
  checks[field] = { status: "rejected", kind: f.kind, reason: f.reason, answer, ...(notes?.length ? { notes } : {}) };
}

/**
 * Checks each field of the model's tool input independently, so one bad field never discards the
 * rest. A field passes only if it parses, cites a page that was actually sent, its quote appears
 * verbatim in that page's sent text, the quote has no personal details, and the value is supported
 * by its own quote. Rejected fields are NOT_FOUND (or an empty list) in `facts`.
 */
export function verifyExtraction(
  raw: Record<string, unknown>,
  ctx: VerifyContext,
  fields: readonly FactField[] = FACT_FIELDS,
): Verification {
  const facts = Object.fromEntries(
    FACT_FIELDS.map((f) => [f, f === "people" || f === "exclusion_signals" ? [] : NOT_FOUND]),
  ) as unknown as ExtractedFacts;
  const checks = {} as Record<FactField, FieldCheck>;
  const set = (field: FactField, value: unknown) => ((facts as Record<string, unknown>)[field] = value);
  // The firm's own name never counts as a personal detail ("Godfrey & Sons").
  const firmNameRaw = raw.firm_name as { value?: unknown } | undefined;
  const firmName = typeof firmNameRaw?.value === "string" ? [firmNameRaw.value] : [];

  for (const field of FACT_FIELDS) {
    if (!fields.includes(field)) {
      checks[field] = { status: "not_found" };
      continue;
    }
    const answer = raw[field];
    if (answer === undefined) {
      checks[field] = { status: "rejected", kind: "missing", reason: "missing from the tool input" };
      continue;
    }
    if (answer === NOT_FOUND || isNotFoundObject(answer) || (Array.isArray(answer) && answer.length === 0)) {
      checks[field] = { status: "not_found" };
      continue;
    }

    // People and exclusion signals: each item stands on its own evidence.
    if (field === "people" || field === "exclusion_signals") {
      const items = Array.isArray(answer) ? answer : [];
      const parsed = ExtractedFactsSchema.shape[field].safeParse(items);
      if (!parsed.success) {
        const kind = formatKind(parsed.error.issues);
        reject(checks, field, { kind, reason: kind === "quote_too_long" ? "evidence_quote is longer than 15 words; choose a shorter span" : `invalid format: ${parsed.error.issues.map((i) => i.message).join("; ")}` }, answer);
        continue;
      }
      const kept: unknown[] = [];
      const notes: string[] = [];
      let firstFailure: Failure | null = null;
      for (const item of parsed.data as ({ name?: string; title?: string | null; signal?: string } & EvidenceRef)[]) {
        let f = checkRef(item, ctx, [...firmName, item.name ?? ""]);
        if (!f && field === "people" && item.name && !valueInText(item.evidence_quote, item.name)) {
          f = { kind: "support_mismatch", reason: `the name "${item.name}" is not in its quote` };
        }
        if (!f && field === "people" && item.title && !valueInText(item.evidence_quote, item.title)) {
          f = { kind: "support_mismatch", reason: `the title "${item.title}" is not in the quote naming ${item.name}` };
        }
        if (f) {
          firstFailure ??= f;
          notes.push(`${field}: dropped ${item.name ?? item.signal} (${f.reason})`);
        } else kept.push(item);
      }
      if (kept.length === 0) reject(checks, field, firstFailure!, answer, notes);
      else {
        set(field, kept);
        const partial = firstFailure !== null && FIXABLE_FAILURES.has(firstFailure.kind);
        checks[field] = { status: "verified", answer, ...(notes.length ? { notes } : {}), ...(partial ? { partial, kind: firstFailure!.kind, reason: firstFailure!.reason } : {}) };
      }
      continue;
    }

    const parsed = ExtractedFactsSchema.shape[field].safeParse(answer);
    if (!parsed.success || parsed.data === NOT_FOUND) {
      const msg = parsed.success ? "not an evidenced value" : parsed.error.issues.map((i) => i.message).join("; ");
      const kind = parsed.success ? "format" : formatKind(parsed.error.issues);
      reject(checks, field, { kind, reason: kind === "quote_too_long" ? "evidence_quote is longer than 15 words; choose a shorter span" : `invalid format: ${msg}` }, answer);
      continue;
    }

    // services, software_mentioned: 1-3 quotes; every kept item must appear in a kept quote.
    if (field === "services" || field === "software_mentioned") {
      const f = parsed.data as { value: string[]; evidence: EvidenceRef[] };
      const notes: string[] = [];
      let firstFailure: Failure | null = null;
      const goodRefs = f.evidence.filter((ref) => {
        const fail = checkRef(ref, ctx, firmName);
        if (fail) {
          firstFailure ??= fail;
          notes.push(`${field}: dropped quote ${JSON.stringify(ref.evidence_quote)} (${fail.reason})`);
        }
        return !fail;
      });
      if (goodRefs.length === 0) {
        reject(checks, field, firstFailure!, answer, notes);
        continue;
      }
      const quotesText = goodRefs.map((r) => r.evidence_quote).join(" \n ");
      const items = f.value.filter((item) => {
        const ok = itemSupported(item, quotesText);
        if (!ok) notes.push(`${field}: dropped "${item}" (not in any of its quotes)`);
        return ok;
      });
      if (items.length === 0) {
        reject(checks, field, { kind: "support_mismatch", reason: "none of the listed items appear in the quotes (give up to 3 separate quotes; split, don't stitch)" }, answer, notes);
        continue;
      }
      set(field, { value: items, evidence: goodRefs });
      const partial = items.length < f.value.length || goodRefs.length < f.evidence.length;
      const partialReason = firstFailure ?? { kind: "support_mismatch" as const, reason: "some listed items are not in any quote (give up to 3 separate quotes; split, don't stitch)" };
      checks[field] = { status: "verified", answer, ...(notes.length ? { notes } : {}), ...(partial ? { partial, kind: partialReason.kind, reason: partialReason.reason } : {}) };
      continue;
    }

    const f = parsed.data as { value: unknown } & EvidenceRef;
    const refFailure = checkRef(f, ctx, firmName);
    if (refFailure) {
      reject(checks, field, refFailure, answer);
      continue;
    }
    const problem = supportProblem(field, f.value, f, ctx);
    if (problem) {
      reject(checks, field, { kind: "support_mismatch", reason: problem }, answer);
      continue;
    }
    // owner_name must be in the same quote as the address; if not, keep the address and drop the name.
    if (field === "public_contact_email") {
      const v = f.value as { address: string; owner_name: string | null };
      if (v.owner_name && !valueInText(f.evidence_quote, v.owner_name)) {
        set(field, { ...f, value: { ...v, owner_name: null } });
        checks[field] = { status: "verified", answer, notes: [`public_contact_email: owner_name "${v.owner_name}" dropped (not in the same quote as the address)`] };
        continue;
      }
    }
    set(field, f);
    checks[field] = { status: "verified", answer };
  }
  return { facts, checks };
}

/** The model sometimes says NOT_FOUND inside the object instead of as the whole field. */
function isNotFoundObject(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return false;
  const a = answer as { evidence_url?: unknown; evidence_quote?: unknown };
  return a.evidence_url === NOT_FOUND || a.evidence_quote === NOT_FOUND;
}

/** Where to look again for a field whose cited page was not usable. */
const FIELD_PAGE_KINDS: Record<FactField, PageKind[]> = {
  firm_name: ["home", "about"],
  firm_type: ["home", "services", "about"],
  location: ["contact", "home", "about"],
  size_signal: ["team", "about"],
  services: ["services", "home"],
  software_mentioned: ["services", "home"],
  client_portal_or_doc_exchange: ["home", "services", "contact"],
  people: ["team", "about"],
  public_contact_email: ["contact", "home"],
  personal_email_domain_on_site: ["contact", "home"],
  privacy_policy_present: ["privacy", "home"],
  security_or_wisp_mention: ["security", "privacy", "home"],
  recent_signal: ["news", "home", "about"],
  phone_or_contact_form: ["contact", "home"],
  exclusion_signals: ["home", "about"],
};

/** Max pages sent in a targeted retry. */
export const MAX_RETRY_PAGES = 2;

/** The first page an answer cited, whatever its shape. */
export function citedUrl(answer: unknown): string | null {
  const a = (Array.isArray(answer) ? answer[0] : answer) as { evidence_url?: unknown; evidence?: { evidence_url?: unknown }[] } | undefined;
  if (typeof a?.evidence_url === "string") return a.evidence_url;
  const e = a?.evidence?.[0]?.evidence_url;
  return typeof e === "string" ? e : null;
}

/**
 * Pages for a targeted retry: the page each failing field cited (when it was a real page), otherwise
 * the most likely page for that field. Never more than MAX_RETRY_PAGES.
 */
export function pagesForRetry(
  failing: { field: FactField; citedUrl: string | null }[],
  sent: { url: string; kind: string }[],
): string[] {
  const chosen: string[] = [];
  const add = (url: string | undefined) => {
    if (url && !chosen.includes(url) && chosen.length < MAX_RETRY_PAGES) chosen.push(url);
  };
  for (const { field, citedUrl: cited } of failing) {
    if (cited && sent.some((p) => p.url === cited)) add(cited);
    else
      for (const kind of FIELD_PAGE_KINDS[field]) {
        const hit = sent.find((p) => p.kind === kind || p.kind === "pasted");
        if (hit) {
          add(hit.url);
          break;
        }
      }
  }
  if (chosen.length === 0 && sent[0]) chosen.push(sent[0].url);
  return chosen;
}
