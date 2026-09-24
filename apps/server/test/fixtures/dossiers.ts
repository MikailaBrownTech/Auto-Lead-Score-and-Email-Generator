import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import { loadScoring } from "../../src/docs/loader";

const PORTAL_KEYWORDS = loadScoring().portal_keywords;

export const HOME = "https://smithtax.example/";
export const ABOUT = "https://smithtax.example/about";
export const PRIVACY = "https://smithtax.example/privacy";

const HASH = "a".repeat(64);

/** A keyword search that qualifies for the "no WISP mention" points: home + about + privacy, no matches. */
export function cleanSearch(keywords: string[]) {
  const page = (url: string, kind: "home" | "about" | "privacy") => ({
    url,
    kind,
    http_status: 200,
    content_type: "text/html; charset=utf-8",
    truncated: false,
    text_chars: 1500,
    sha256: HASH,
  });
  return { keywords, pages: [page(HOME, "home"), page(ABOUT, "about"), page(PRIVACY, "privacy")], matches: [] };
}

export function ev<T>(value: T, quote = "quoted text from the page", url = HOME) {
  return { value, evidence_url: url, evidence_quote: quote };
}

export function dnsEv<T>(value: T, name = "_dmarc.smithtax.example", type = "TXT") {
  return { value, evidence_url: `dns:${type} ${name}`, evidence_quote: "no record" };
}

/** A qualified dossier with every fact found and every scoring signal present (scores 100). */
export function strongDossier(overrides: Partial<Dossier> = {}, wispKeywords: string[] = ["wisp", "encryption"]): Dossier {
  return {
    lead_id: "L1",
    source: "web",
    url: HOME,
    domain: "smithtax.example",
    pages_opened: [HOME, ABOUT, PRIVACY],
    failures: [],
    prompt_injection_flag: false,
    injection_findings: [],
    declined_automated_access: false,
    firm_name_candidates: [],
    firm_name: ev("Smith Tax Services", "Smith Tax Services"),
    firm_type: ev({ primary: "tax_preparer" as const, secondary: [] }, "Tax preparation for individuals and small businesses"),
    location: ev({ city: "Columbus", state: "OH", country: "US" }, "Serving Columbus, Ohio since 2004"),
    size_signal: ev({ staff_count: 6, text: "our team of six" }, "our team of six", ABOUT),
    client_count_signal: NOT_FOUND,
    services: {
      value: ["Individual tax returns", "Payroll services"],
      evidence: [
        { item: "Individual tax returns", evidence_url: HOME },
        { item: "Payroll services", evidence_url: HOME },
      ],
    },
    software_mentioned: { value: ["Drake"], evidence: [{ item: "Drake", evidence_url: HOME }] },
    client_portal_or_doc_exchange: ev({ doc_exchange: true as const, secure_portal: null }, "email us your documents"),
    people: [{ name: "Jane Smith", title: "Owner", evidence_url: ABOUT, evidence_quote: "Jane Smith, EA, Owner" }],
    public_contact_email: ev({ address: "jane@smithtax.example", owner_name: null }, "jane@smithtax.example"),
    personal_email_domain_on_site: ev("smithtaxes@gmail.com", "smithtaxes@gmail.com"),
    privacy_policy_present: ev(true as const, "Privacy Policy", PRIVACY),
    security_or_wisp_mention: NOT_FOUND,
    phone_or_contact_form: ev({ phone: "(614) 555-0100", contact_form: null }, "Call (614) 555-0100"),
    exclusion_signals: [],
    decision_maker: ev({ name: "Jane Smith", title: "Owner", role_confirmed: true }, "Jane Smith, EA, Owner", ABOUT),
    public_email_kind: "named_person",
    latest_dated_content: {
      value: { date: "2026-02-10", source: "time_element" },
      evidence_url: HOME,
      evidence_quote: "2026-02-10",
    },
    us_location: { value: true, reason: "country US", qualifying_type: null },
    target_industry_fit: { value: true, reason: "primary type tax_preparer is a target type", qualifying_type: "tax_preparer" },
    gate: { status: "qualified", reasons: [] },
    dns: {
      mx_provider: dnsEv("Google Workspace", "smithtax.example", "MX"),
      no_domain_email: dnsEv(false, "smithtax.example", "MX"),
      spf_present: dnsEv(true, "smithtax.example"),
      dmarc_present: dnsEv(false),
      dmarc_policy: NOT_FOUND,
      dkim: "NOT_CHECKED",
    },
    security_mention_search: cleanSearch(wispKeywords),
    portal_mention_search: cleanSearch(PORTAL_KEYWORDS),
    email_security_hint: NOT_FOUND,
    ...overrides,
  };
}

/** Every fact NOT_FOUND. Must score 0. */
export function emptyDossier(): Dossier {
  return {
    lead_id: "L0",
    source: "web",
    url: HOME,
    domain: "smithtax.example",
    pages_opened: [HOME],
    failures: ["about page returned 404"],
    prompt_injection_flag: false,
    injection_findings: [],
    declined_automated_access: false,
    firm_name_candidates: [],
    firm_name: NOT_FOUND,
    firm_type: NOT_FOUND,
    location: NOT_FOUND,
    size_signal: NOT_FOUND,
    client_count_signal: NOT_FOUND,
    services: NOT_FOUND,
    software_mentioned: NOT_FOUND,
    client_portal_or_doc_exchange: NOT_FOUND,
    people: [],
    public_contact_email: NOT_FOUND,
    personal_email_domain_on_site: NOT_FOUND,
    privacy_policy_present: NOT_FOUND,
    security_or_wisp_mention: NOT_FOUND,
    phone_or_contact_form: NOT_FOUND,
    exclusion_signals: [],
    decision_maker: NOT_FOUND,
    public_email_kind: NOT_FOUND,
    latest_dated_content: NOT_FOUND,
    us_location: { value: null, reason: "location is NOT_FOUND", qualifying_type: null },
    target_industry_fit: { value: null, reason: "firm type and services are NOT_FOUND", qualifying_type: null },
    gate: { status: "qualified", reasons: [] },
    dns: {
      mx_provider: NOT_FOUND,
      no_domain_email: NOT_FOUND,
      spf_present: NOT_FOUND,
      dmarc_present: NOT_FOUND,
      dmarc_policy: NOT_FOUND,
      dkim: "NOT_CHECKED",
    },
    security_mention_search: "NOT_CHECKED",
    portal_mention_search: "NOT_CHECKED",
    email_security_hint: NOT_FOUND,
  };
}
