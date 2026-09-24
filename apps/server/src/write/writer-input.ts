import {
  isFound,
  type ApprovedSentence,
  type Dossier,
  type EvidenceConfig,
  type FirmType,
  type OfferConfig,
  type StyleConfig,
  type WriterGrounding,
} from "@clearpath/shared";
import { keywordIn, personalTermIn, valueInText } from "../extract/verify";

/**
 * The hedged DNS remark an email may carry, worded by code. Only when the include_dns_observation
 * setting is on, the domain has email (MX records), and the DMARC finding is evidenced by a lookup.
 * Never "vulnerable" or "at risk"; never DKIM.
 */
export function dnsObservation(d: Dossier, offer: OfferConfig): string | null {
  if (!offer.include_dns_observation) return null;
  const noEmail = d.dns.no_domain_email;
  if (!isFound(noEmail) || noEmail.value !== false) return null;
  if (isFound(d.dns.dmarc_present) && d.dns.dmarc_present.value === false) {
    return "I noticed your domain does not publish a DMARC record.";
  }
  if (isFound(d.dns.dmarc_policy) && d.dns.dmarc_policy.value === "none") {
    return "I noticed your domain publishes a DMARC record set to monitoring only.";
  }
  return null;
}

export interface VerifiedValues {
  /** Verified values only: no evidence quotes, no URLs, no email addresses, no people. */
  prospect_facts: Record<string, unknown>;
  /** Values removed by the personal-detail filter (reported, never sent). */
  filtered: string[];
}

/** Anything that must never reach the writer even inside a value: links, addresses, dollar figures. */
const UNSAFE_VALUE = /https?:\/\/|www\.|@|\$\s?\d|\bpenalt(y|ies)\b|\bfines?\b/i;

/**
 * The lead's verified values (never evidence quotes or page text), passed through the personal-detail
 * filter (docs/06 personal_terms; the firm's own name is exempt). People, emails, phones, and quotes
 * are left out entirely. The code uses these to pick details and to detect which facts an email uses;
 * the writer itself gets only planSequence's constrained input.
 */
export function verifiedValues(d: Dossier, offer: OfferConfig, evidence: EvidenceConfig): VerifiedValues {
  const filtered: string[] = [];
  const firmName = isFound(d.firm_name) ? d.firm_name.value : null;
  const safe = (field: string, v: string): boolean => {
    const scanned = firmName ? v.split(firmName).join(" ") : v;
    const term = personalTermIn(scanned, evidence.personal_terms);
    if (term || UNSAFE_VALUE.test(v)) {
      filtered.push(`${field}: "${v}" (${term ? `personal detail "${term}"` : "link, address, or money figure"})`);
      return false;
    }
    return true;
  };

  const facts: Record<string, unknown> = {};
  if (firmName && safe("firm_name", firmName)) facts.firm_name = firmName;
  if (isFound(d.firm_type)) {
    // The qualifying type (docs/06) leads when the primary type is not a target (credit repair + tax prep).
    const qualifying = d.target_industry_fit.qualifying_type;
    facts.firm_type = { primary: d.firm_type.value.primary, secondary: d.firm_type.value.secondary, ...(qualifying ? { qualifying_type: qualifying } : {}) };
  }
  if (isFound(d.location)) {
    const { city, state } = d.location.value;
    const loc = { ...(city && safe("location", city) ? { city } : {}), ...(state && safe("location", state) ? { state } : {}) };
    if (Object.keys(loc).length > 0) facts.location = loc;
  }
  if (isFound(d.size_signal) && d.size_signal.value.staff_count !== null) facts.size_signal = { staff_count: d.size_signal.value.staff_count };
  for (const field of ["services", "software_mentioned"] as const) {
    const f = d[field];
    if (!isFound(f)) continue;
    const items = f.value.filter((v) => safe(field, v)).slice(0, 10);
    if (items.length > 0) facts[field] = items;
  }
  if (isFound(d.client_portal_or_doc_exchange)) facts.client_portal_or_doc_exchange = d.client_portal_or_doc_exchange.value;
  const dns = dnsObservation(d, offer);
  if (dns) facts.dns_observation = dns;
  return { prospect_facts: facts, filtered };
}

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const DNS_WORDS = /\b(dmarc|spf|dkim|mx records?|dns)\b/i;

/**
 * Which prospect facts an email actually uses, found by code in its text (the writer's own word is
 * never trusted). Whole-phrase matches against all of the lead's verified values.
 */
export function detectGrounding(text: string, facts: Record<string, unknown>): WriterGrounding[] {
  const out: WriterGrounding[] = [];
  const f = facts as {
    firm_name?: string;
    location?: { city?: string; state?: string };
    size_signal?: { staff_count: number };
    services?: string[];
    software_mentioned?: string[];
    client_portal_or_doc_exchange?: unknown;
    dns_observation?: string;
  };
  if (f.firm_name && valueInText(text, f.firm_name)) out.push("firm_name");
  const { city, state } = f.location ?? {};
  if ((city && valueInText(text, city)) || (state && state.length > 2 && valueInText(text, state))) out.push("location");
  if (f.size_signal) {
    const n = f.size_signal.staff_count;
    const as = [String(n), NUMBER_WORDS[n]].filter(Boolean).join("|");
    if (new RegExp(`\\b(${as})[- ](person|people|staff|employees?|members?|professionals?)\\b|\\bteam of (${as})\\b`, "i").test(text)) out.push("size_signal");
  }
  if (f.services?.some((s) => valueInText(text, s))) out.push("services");
  if (f.software_mentioned?.some((s) => valueInText(text, s))) out.push("software_mentioned");
  if (f.client_portal_or_doc_exchange !== undefined && /\bportal\b|\bdocument exchange\b|\bfile sharing\b/i.test(text)) out.push("client_portal_or_doc_exchange");
  if (DNS_WORDS.test(text)) out.push("dns_observation");
  return out;
}

/** The one prospect detail an email may use, chosen by code. Never people or dollar figures. */
export interface Detail {
  field: "services" | "software_mentioned" | "size_signal";
  value: string;
}

/**
 * Candidate details, ranked: services (those naming the qualifying type first, then page order) >
 * software > staff-size phrase. Values have already passed the personal-detail filter.
 */
export function rankDetails(values: Record<string, unknown>, evidence: EvidenceConfig, type: FirmType | null): Detail[] {
  const v = values as { services?: string[]; software_mentioned?: string[]; size_signal?: { staff_count: number } };
  const keywords = type && type !== "other" ? evidence.firm_type_keywords[type] : [];
  const onType = (s: string) => keywords.some((k) => keywordIn(s, k));
  const services = [...(v.services ?? [])].sort((a, b) => Number(onType(b)) - Number(onType(a)));
  return [
    ...services.map((value) => ({ field: "services" as const, value })),
    ...(v.software_mentioned ?? []).map((value) => ({ field: "software_mentioned" as const, value })),
    ...(v.size_signal ? [{ field: "size_signal" as const, value: `a team of ${v.size_signal.staff_count}` }] : []),
  ];
}

export interface EmailPlan {
  n: number;
  purpose: string;
  /** The only prospect detail this email may use (emails 1 and 2), or null. */
  detail: Detail | null;
  /** The approved docs/02 sentence the code inserts between opening and closing, or null (no slot). */
  approved: ApprovedSentence | null;
  /** Code-worded DNS remark inserted before the slot (email 1 only, include_dns_observation). */
  dnsSentence: string | null;
  /** Word budget for the model's own text (limit minus greeting and inserted sentences); null = sentence count. */
  modelWords: number | null;
}

export interface WritePlan {
  /** Shared context for every email. location is a free contextual reference, not a detail. */
  context: {
    firm_name: string | null;
    firm_type: FirmType;
    location: { city?: string; state?: string } | null;
    persona: string;
    angle: string;
    greeting: string;
  };
  emails: EmailPlan[];
  /** Personal-detail filter log. */
  filtered: string[];
  /** All verified values (grounding detection), never sent to the writer. */
  values: Record<string, unknown>;
}

const PURPOSES: Record<number, string> = {
  1: "one observation that uses the detail, then one question",
  2: "a short follow-up that uses the detail; end with one question",
  3: "offer the one-page checklist by reply; do not name any rule or agency and do not judge the firm",
  4: "a short note around the inserted sentence, then the assessment link",
  5: "a brief, polite break-up of 2 to 3 sentences",
};

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

/** The approved sentence for an email slot: the first one listing that email and the firm type (or "any"). */
export function approvedFor(n: number, type: FirmType, approved: ApprovedSentence[]): ApprovedSentence | null {
  return approved.find((s) => s.emails.includes(n) && (s.firm_types.includes(type) || s.firm_types.includes("any"))) ?? null;
}

/** Emails with a regulatory slot: 1 (applicability), 2 (one requirement), 4 (the checklist). */
export const SLOT_EMAILS: ReadonlySet<number> = new Set([1, 2, 4]);

/**
 * The writer's constrained input, decided entirely by code: the firm type (the qualifying type
 * leads), the docs/08 persona, the angle, the greeting, the city/state as context, and for emails 1
 * and 2 exactly one ranked detail. Regulatory content is never the writer's: slots get approved
 * docs/02 sentences, inserted verbatim.
 */
export function planSequence(
  d: Dossier,
  customNs: number[],
  deps: { offer: OfferConfig; evidence: EvidenceConfig; style: StyleConfig; approved: ApprovedSentence[]; personas: string[]; greeting: string },
): WritePlan {
  const { prospect_facts: values, filtered } = verifiedValues(d, deps.offer, deps.evidence);
  const type: FirmType = d.target_industry_fit.qualifying_type ?? (isFound(d.firm_type) ? d.firm_type.value.primary : "other");
  const details = rankDetails(values, deps.evidence, type);
  const dns = dnsObservation(d, deps.offer);
  const greetingWords = deps.greeting.trim().split(/\s+/).length;
  const emails = customNs.map((n): EmailPlan => {
    const approved = SLOT_EMAILS.has(n) ? approvedFor(n, type, deps.approved) : null;
    const dnsSentence = n === 1 ? dns : null;
    const inserted = [approved?.text, dnsSentence].filter(Boolean).join(" ").split(/\s+/).filter(Boolean).length;
    const limit = n <= 4 ? deps.style.word_limits[String(n) as "1"] : null;
    return {
      n,
      purpose: PURPOSES[n]!,
      detail: n <= 2 ? (details[n - 1] ?? details[0] ?? null) : null,
      approved,
      dnsSentence,
      modelWords: limit === null ? null : Math.max(15, limit - greetingWords - inserted),
    };
  });
  return {
    context: {
      firm_name: (values.firm_name as string | undefined) ?? null,
      firm_type: type,
      location: (values.location as { city?: string; state?: string } | undefined) ?? null,
      persona: personaFor(type, deps.personas),
      angle: deps.style.firm_type_angles[type][0]!,
      greeting: deps.greeting,
    },
    emails,
    filtered,
    values,
  };
}
