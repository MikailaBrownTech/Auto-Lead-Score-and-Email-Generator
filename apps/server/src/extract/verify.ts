import {
  containsPhrase,
  ExtractedFactsSchema,
  countWords,
  FACT_FIELDS,
  MAX_LIST_ITEMS,
  MAX_QUOTE_WORDS,
  ModelFactsSchema,
  NOT_FOUND,
  normalizeText,
  type EvidenceConfig,
  type EvidenceRef,
  type ExtractedFacts,
  type FactField,
  type PageKind,
} from "@clearpath/shared";
import { z } from "zod";

export type FieldStatus = "verified" | "not_found" | "rejected";

/**
 * Why a field failed. Only the fixable kinds are retried: the model can pick a better quote or
 * page. Format failures (wrong type, bad enum, invalid email) are not retried.
 */
/** not_on_page: a services/software item the code could not find in any fetched page (dropped, never retried). */
export type FailureKind = "format" | "missing" | "url_not_sent" | "quote_not_found" | "quote_too_long" | "support_mismatch" | "personal_details" | "not_on_page";
export const FIXABLE_FAILURES: ReadonlySet<FailureKind> = new Set(["url_not_sent", "quote_not_found", "quote_too_long", "support_mismatch", "personal_details"]);

/** A schema failure caused only by quote length is fixable (the model can pick a shorter span). */
function formatKind(issues: { path: (string | number)[]; message: string }[]): FailureKind {
  return issues.length > 0 && issues.every((i) => i.path[i.path.length - 1] === "evidence_quote" && /15 words/.test(i.message)) ? "quote_too_long" : "format";
}

/**
 * Only code may record an absence. For the model's booleans the allowed values are true (with
 * evidence) or NOT_FOUND: a false becomes null inside an object, and a field with nothing true left
 * becomes NOT_FOUND. Returns the cleaned answer, or null for NOT_FOUND, plus a note when it changed.
 */
export function dropFalseBooleans(field: FactField, answer: unknown): { answer: unknown; note: string | null } {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return { answer, note: null };
  const a = answer as { value?: unknown };
  const note = `${field}: the model answered false; only code may record an absence (false dropped)`;
  if (field === "privacy_policy_present") {
    return a.value === false ? { answer: null, note } : { answer, note: null };
  }
  if (field === "client_portal_or_doc_exchange" || field === "phone_or_contact_form") {
    if (typeof a.value !== "object" || a.value === null) return { answer, note: null };
    const v = { ...(a.value as Record<string, unknown>) };
    const keys = field === "client_portal_or_doc_exchange" ? ["doc_exchange", "secure_portal"] : ["contact_form"];
    let changed = false;
    for (const k of keys) {
      if (v[k] === false) {
        v[k] = null;
        changed = true;
      }
    }
    const nothingLeft =
      field === "client_portal_or_doc_exchange" ? v.doc_exchange !== true && v.secure_portal !== true : v.contact_form !== true && (v.phone === null || v.phone === undefined || v.phone === "");
    if (nothingLeft) return { answer: null, note: changed ? note : null };
    return { answer: { ...a, value: v }, note: changed ? note : null };
  }
  return { answer, note: null };
}

const CLIENT_WORDS = /\b(clients?|customers?|compan(y|ies)|businesses|families|households|individuals|returns|taxpayers|organizations)\b/i;
const STAFF_WORDS = /\b(staff|employees?|team|teammates|professionals|accountants|cpas|preparers|bookkeepers|people on)\b/i;

/** A size_signal whose quote counts clients (not people working at the firm) is a client count. */
export function isClientCount(quote: string, text: string): boolean {
  const s = `${quote} ${text}`;
  return CLIENT_WORDS.test(s) && !STAFF_WORDS.test(s);
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
  /**
   * Full cleaned text of every fetched page (not the token-capped copy), in search order. services and
   * software items are looked up here. Defaults to the sent pages.
   */
  searchPages?: { url: string; text: string }[];
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

/**
 * services/software: each item is kept only if its normalized text (case, punctuation, "&" = "and")
 * appears as a whole phrase in a fetched page's cleaned text. The first page containing it is its evidence.
 */
export function findListItems(
  items: string[],
  ctx: VerifyContext,
): { found: { item: string; evidence_url: string }[]; dropped: { item: string; reason: string }[] } {
  const pages = ctx.searchPages ?? [...ctx.pages].map(([url, p]) => ({ url, text: p.text }));
  const found: { item: string; evidence_url: string }[] = [];
  const dropped: { item: string; reason: string }[] = [];
  for (const raw of items) {
    const item = raw.trim();
    if (found.some((f) => wordsOf(f.item) === wordsOf(item))) continue;
    const term = personalTermIn(item, ctx.evidence.personal_terms);
    if (term) {
      dropped.push({ item, reason: `contains a personal detail ("${term}")` });
      continue;
    }
    const page = pages.find((p) => valueInText(p.text, item));
    if (page) found.push({ item, evidence_url: page.url });
    else dropped.push({ item, reason: "not found in the text of any fetched page" });
  }
  return { found, dropped };
}

/** A list item is supported when every significant word of it appears in the quotes. */
export function itemSupported(item: string, quotesText: string): boolean {
  const words = wordsOf(item).split(" ").filter((w) => w.length >= 3 && !LIST_STOPWORDS.has(w));
  const hay = ` ${wordsOf(quotesText)} `;
  if (words.length === 0) return valueInText(quotesText, item);
  return words.every((w) => hay.includes(` ${w} `));
}

/** A docs/06 keyword match that also accepts a plural ("audit" matches "audits"). */
export function keywordIn(text: string, keyword: string): boolean {
  return containsPhrase(text, keyword) || containsPhrase(text, `${keyword}s`) || containsPhrase(text, `${keyword}es`);
}

/** Does this span still carry the value its field needs? (Used to cut an over-long quote.) */
function spanHasValue(field: FactField, value: unknown, span: string, ctx: VerifyContext): boolean {
  switch (field) {
    case "firm_name":
      return typeof value === "string" && valueInText(span, value);
    case "firm_type": {
      const primary = (value as { primary?: string })?.primary;
      const keywords = ctx.evidence.firm_type_keywords[primary as keyof EvidenceConfig["firm_type_keywords"]] ?? [];
      return keywords.some((k) => keywordIn(span, k));
    }
    case "location": {
      const city = (value as { city?: string | null })?.city;
      return typeof city === "string" && valueInText(span, city);
    }
    case "public_contact_email":
      return typeof (value as { address?: unknown })?.address === "string" && textContains(span, (value as { address: string }).address);
    case "personal_email_domain_on_site":
      return typeof value === "string" && textContains(span, value);
    case "phone_or_contact_form": {
      const phone = (value as { phone?: string | null })?.phone;
      return typeof phone === "string" && digits(phone).length >= 7 && digits(span).includes(digits(phone));
    }
    default:
      return false;
  }
}

/**
 * An over-long quote that is verbatim on its page is cut by the code to the first 15-word window that
 * still holds the value (a contiguous span of a verbatim span is itself verbatim). Only for fields
 * whose value can be located in the quote; everything else still fails as quote_too_long.
 */
export function shortenQuote(field: FactField, answer: unknown, ctx: VerifyContext): { answer: unknown; note: string } | null {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const a = answer as { value?: unknown; evidence_url?: unknown; evidence_quote?: unknown };
  if (typeof a.evidence_quote !== "string" || typeof a.evidence_url !== "string") return null;
  const n = countWords(a.evidence_quote);
  if (n <= MAX_QUOTE_WORDS) return null;
  const page = ctx.pages.get(a.evidence_url);
  if (!page) return null;
  const inTitle = field === "firm_name" && quoteInText(page.title, a.evidence_quote);
  if (!quoteInText(page.text, a.evidence_quote) && !inTitle) return null;
  const words = a.evidence_quote.trim().split(/\s+/);
  for (let i = 0; i + MAX_QUOTE_WORDS <= words.length; i++) {
    const span = words.slice(i, i + MAX_QUOTE_WORDS).join(" ");
    if (spanHasValue(field, a.value, span, ctx)) {
      return { answer: { ...a, evidence_quote: span }, note: `${field}: quote cut by code from ${n} to ${MAX_QUOTE_WORDS} words around the value` };
    }
  }
  return null;
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
function checkRef(ref: EvidenceRef, ctx: VerifyContext, ignore: string[] = [], allowTitle = false): Failure | null {
  const page = ctx.pages.get(ref.evidence_url);
  if (!page) return { kind: "url_not_sent", reason: `evidence_url ${ref.evidence_url} is not one of the pages provided` };
  if (!quoteInText(page.text, ref.evidence_quote) && !(allowTitle && quoteInText(page.title, ref.evidence_quote))) {
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
      return keywords.some((k) => keywordIn(quote, k)) ? null : `the quote has no ${primary} keyword (docs/06 firm_type_keywords)`;
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
    let answer = raw[field];
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

    // services, software_mentioned: plain lists; each item must be found in a fetched page's text.
    // Never rejected for length: the first MAX_LIST_ITEMS items found are kept, the rest dropped.
    if (field === "services" || field === "software_mentioned") {
      const list = LenientList.safeParse(answer);
      if (!list.success) {
        reject(checks, field, { kind: "format", reason: `invalid format: ${list.error.issues.map((i) => i.message).join("; ")}` }, answer);
        continue;
      }
      const { found: all, dropped } = findListItems(list.data.filter((s) => s.trim() !== ""), ctx);
      const found = all.slice(0, MAX_LIST_ITEMS);
      const notes = dropped.map((d) => `${field}: dropped "${d.item}" (${d.reason})`);
      if (all.length > MAX_LIST_ITEMS) notes.push(`${field}: kept the first ${MAX_LIST_ITEMS} items found; dropped ${all.length - MAX_LIST_ITEMS} more`);
      if (found.length === 0) {
        reject(checks, field, { kind: "not_on_page", reason: "none of the listed items were found in the page text" }, answer, notes);
        continue;
      }
      set(field, { value: found.map((f) => f.item), evidence: found });
      checks[field] = { status: "verified", answer, ...(notes.length ? { notes } : {}) };
      continue;
    }

    const cleaned = dropFalseBooleans(field, answer);
    const booleanNotes = cleaned.note ? [cleaned.note] : [];
    if (cleaned.answer === null) {
      checks[field] = { status: "not_found", answer, ...(booleanNotes.length ? { notes: booleanNotes } : {}) };
      continue;
    }
    answer = cleaned.answer;
    const cut = shortenQuote(field, answer, ctx);
    const cutNotes = [...booleanNotes, ...(cut ? [cut.note] : [])];
    const parsed = ExtractedFactsSchema.shape[field].safeParse(cut ? cut.answer : answer);
    if (!parsed.success || parsed.data === NOT_FOUND) {
      const msg = parsed.success ? "not an evidenced value" : parsed.error.issues.map((i) => i.message).join("; ");
      const kind = parsed.success ? "format" : formatKind(parsed.error.issues);
      reject(checks, field, { kind, reason: kind === "quote_too_long" ? "evidence_quote is longer than 15 words; choose a shorter span" : `invalid format: ${msg}` }, answer);
      continue;
    }

    const f = parsed.data as { value: unknown } & EvidenceRef;
    const refFailure = checkRef(f, ctx, firmName, field === "firm_name");
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
        checks[field] = { status: "verified", answer, notes: [...cutNotes, `public_contact_email: owner_name "${v.owner_name}" dropped (not in the same quote as the address)`] };
        continue;
      }
    }
    set(field, f);
    checks[field] = { status: "verified", answer, ...(cutNotes.length ? { notes: cutNotes } : {}) };
  }
  // size_signal holds staff counts only; a count of clients served moves to client_count_signal.
  const size = facts.size_signal;
  if (size !== NOT_FOUND && isClientCount(size.evidence_quote, size.value.text)) {
    if (facts.client_count_signal === NOT_FOUND) {
      facts.client_count_signal = { value: { count: size.value.staff_count, text: size.value.text }, evidence_url: size.evidence_url, evidence_quote: size.evidence_quote };
    }
    facts.size_signal = NOT_FOUND;
    const note = "size_signal: the quote counts clients, not staff; moved to client_count_signal (not scored)";
    checks.size_signal = { ...checks.size_signal, notes: [...(checks.size_signal.notes ?? []), note] };
  }
  return { facts, checks };
}

/** services/software as sent: any number of strings (length is never a reason to reject the field). */
const LenientList = z.array(z.string());

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
  phone_or_contact_form: ["contact", "home"],
  exclusion_signals: ["home", "about"],
  client_count_signal: ["home", "about"],
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
