import { isFound, type ApprovedSentence, type Dossier, type EvidenceConfig, type FirmType, type OfferConfig, type WriterGrounding } from "@clearpath/shared";
import { personalTermIn, valueInText } from "../extract/verify";

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
 * are left out entirely. The personal-line model sees only firm, type, city/state, and a few services
 * from these; the code uses all of them to detect which facts a line uses.
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
 * Which prospect facts a text actually uses, found by code (the model's own word is never trusted). Whole-phrase matches against all of the lead's verified values.
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

/** The approved docs/02 sentence for an email: the first one listing that email and the firm type (or "any"). */
export function approvedFor(n: number, type: FirmType, approved: ApprovedSentence[]): ApprovedSentence | null {
  return approved.find((x) => x.emails.includes(n) && (x.firm_types.includes(type) || x.firm_types.includes("any"))) ?? null;
}
