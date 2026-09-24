import {
  ExtractedFactsSchema,
  FACT_FIELDS,
  NOT_FOUND,
  normalizeText,
  type ExtractedFacts,
  type FactField,
  type PageKind,
} from "@clearpath/shared";

export type FieldStatus = "verified" | "not_found" | "rejected";

export interface FieldCheck {
  status: FieldStatus;
  /** Why a field was rejected (shown in the retry request and in failures). */
  reason?: string;
  /** The model's answer as given, for reporting. */
  answer?: unknown;
}

export interface Verification {
  facts: ExtractedFacts;
  checks: Record<FactField, FieldCheck>;
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

/** The model sometimes says NOT_FOUND inside the object instead of as the whole field. */
function isNotFoundObject(answer: unknown): boolean {
  if (typeof answer !== "object" || answer === null) return false;
  const a = answer as { evidence_url?: unknown; evidence_quote?: unknown };
  return a.evidence_url === NOT_FOUND || a.evidence_quote === NOT_FOUND;
}

function digits(s: string): string {
  return s.replace(/\D/g, "");
}

/** Extra checks that the value itself (not just the quote) appears on the evidence page. */
function valueProblem(field: FactField, value: unknown, pageText: string): string | null {
  switch (field) {
    case "public_contact_email":
    case "personal_email_domain_on_site":
      return textContains(pageText, String(value)) ? null : `the address ${String(value)} does not appear on that page`;
    case "decision_maker": {
      const name = (value as { name: string }).name;
      return textContains(pageText, name) ? null : `the name ${name} does not appear on that page`;
    }
    case "phone_or_contact_form": {
      const phone = (value as { phone: string | null }).phone;
      if (phone && digits(phone).length >= 7 && !digits(pageText).includes(digits(phone))) {
        return `the phone number ${phone} does not appear on that page`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Checks each field of the model's tool input independently, so one bad field never discards the
 * rest. A field passes only if it parses, cites a page that was actually sent, and its quote appears
 * in that page's sent text (plus value checks for emails, phones, and names). Everything else is
 * rejected with a reason; rejected fields are NOT_FOUND in `facts`.
 */
export function verifyExtraction(
  raw: Record<string, unknown>,
  sentPages: Map<string, string>,
  fields: readonly FactField[] = FACT_FIELDS,
): Verification {
  const facts = Object.fromEntries(FACT_FIELDS.map((f) => [f, NOT_FOUND])) as ExtractedFacts;
  const checks = {} as Record<FactField, FieldCheck>;

  for (const field of FACT_FIELDS) {
    if (!fields.includes(field)) {
      checks[field] = { status: "not_found" };
      continue;
    }
    const answer = raw[field];
    if (answer === undefined) {
      checks[field] = { status: "rejected", reason: "missing from the tool input" };
      continue;
    }
    if (answer === NOT_FOUND || isNotFoundObject(answer)) {
      checks[field] = { status: "not_found" };
      continue;
    }
    const parsed = ExtractedFactsSchema.shape[field].safeParse(answer);
    if (!parsed.success || parsed.data === NOT_FOUND) {
      const msg = parsed.success ? "not an evidenced value" : parsed.error.issues.map((i) => i.message).join("; ");
      checks[field] = { status: "rejected", reason: `invalid format: ${msg}`, answer };
      continue;
    }
    const f = parsed.data as { value: unknown; evidence_url: string; evidence_quote: string };
    const pageText = sentPages.get(f.evidence_url);
    if (pageText === undefined) {
      checks[field] = { status: "rejected", reason: `evidence_url ${f.evidence_url} is not one of the pages provided`, answer };
      continue;
    }
    if (!quoteInText(pageText, f.evidence_quote)) {
      checks[field] = { status: "rejected", reason: "evidence_quote was not found word for word in that page's text", answer };
      continue;
    }
    const problem = valueProblem(field, f.value, pageText);
    if (problem) {
      checks[field] = { status: "rejected", reason: problem, answer };
      continue;
    }
    (facts as Record<string, unknown>)[field] = f;
    checks[field] = { status: "verified", answer };
  }
  return { facts, checks };
}

/** Where to look again for a field whose cited page was not usable. */
const FIELD_PAGE_KINDS: Record<FactField, PageKind[]> = {
  firm_name: ["home", "about"],
  firm_type: ["home", "services", "about"],
  location: ["contact", "home", "about"],
  in_scope: ["home", "about"],
  size_signal: ["team", "about"],
  services: ["services", "home"],
  software_mentioned: ["services", "home"],
  client_portal_or_doc_exchange: ["home", "services", "contact"],
  decision_maker: ["team", "about"],
  public_contact_email: ["contact", "home"],
  personal_email_domain_on_site: ["contact", "home"],
  privacy_policy_present: ["privacy", "home"],
  security_or_wisp_mention: ["security", "privacy", "home"],
  recent_signal: ["home", "about", "services"],
  phone_or_contact_form: ["contact", "home"],
  latest_dated_content: ["home", "services", "about"],
};

/** Max pages sent in a targeted retry. */
export const MAX_RETRY_PAGES = 2;

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
  for (const { field, citedUrl } of failing) {
    if (citedUrl && sent.some((p) => p.url === citedUrl)) add(citedUrl);
    else for (const kind of FIELD_PAGE_KINDS[field]) {
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
