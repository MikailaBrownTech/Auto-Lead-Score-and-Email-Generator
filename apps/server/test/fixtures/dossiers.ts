import { NOT_FOUND, type Dossier } from "@clearpath/shared";

export const HOME = "https://smithtax.example/";
export const ABOUT = "https://smithtax.example/about";

export function ev<T>(value: T, quote = "quoted text from the page", url = HOME) {
  return { value, evidence_url: url, evidence_quote: quote };
}

export function dnsEv<T>(value: T, name = "_dmarc.smithtax.example", type = "TXT") {
  return { value, evidence_url: `dns:${type} ${name}`, evidence_quote: "no record" };
}

/** A dossier with every fact found and every scoring signal present (scores 90 of 100). */
export function strongDossier(overrides: Partial<Dossier> = {}): Dossier {
  return {
    lead_id: "L1",
    source: "web",
    url: HOME,
    domain: "smithtax.example",
    pages_opened: [HOME, ABOUT],
    failures: [],
    prompt_injection_flag: false,
    firm_name: ev("Smith Tax Services", "Smith Tax Services"),
    firm_type: ev("tax_preparer" as const, "Tax preparation for individuals and small businesses"),
    location: ev({ city: "Columbus", state: "OH", country: "US" }, "Serving Columbus, Ohio since 2004"),
    in_scope: ev(true, "Serving Columbus, Ohio since 2004"),
    size_signal: ev({ staff_count: 6, text: "our team of six" }, "our team of six", ABOUT),
    services: ev(["Individual tax returns", "Payroll services"], "Individual tax returns and payroll services"),
    software_mentioned: ev(["Drake"], "We file with Drake Tax"),
    client_portal_or_doc_exchange: ev({ doc_exchange: true, secure_portal: false }, "email us your documents"),
    decision_maker: ev({ name: "Jane Smith", title: "Owner" }, "Jane Smith, EA, Owner", ABOUT),
    public_contact_email: ev("office@smithtax.example", "office@smithtax.example"),
    personal_email_domain_on_site: ev("smithtaxes@gmail.com", "smithtaxes@gmail.com"),
    privacy_policy_present: ev(false, "Privacy"),
    security_or_wisp_mention: NOT_FOUND,
    recent_signal: ev({ text: "Now offering bookkeeping", date: "2026-06" }, "New for 2026: bookkeeping"),
    phone_or_contact_form: ev({ phone: "(614) 555-0100", contact_form: false }, "Call (614) 555-0100"),
    latest_dated_content: ev({ text: "2026 tax deadlines post", date: "2026-02-10" }, "Posted February 10, 2026"),
    dns: {
      mx_provider: dnsEv("Google Workspace", "smithtax.example", "MX"),
      spf_present: dnsEv(true, "smithtax.example"),
      dmarc_present: dnsEv(false),
      dmarc_policy: NOT_FOUND,
      dkim: "NOT_CHECKED",
    },
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
    firm_name: NOT_FOUND,
    firm_type: NOT_FOUND,
    location: NOT_FOUND,
    in_scope: NOT_FOUND,
    size_signal: NOT_FOUND,
    services: NOT_FOUND,
    software_mentioned: NOT_FOUND,
    client_portal_or_doc_exchange: NOT_FOUND,
    decision_maker: NOT_FOUND,
    public_contact_email: NOT_FOUND,
    personal_email_domain_on_site: NOT_FOUND,
    privacy_policy_present: NOT_FOUND,
    security_or_wisp_mention: NOT_FOUND,
    recent_signal: NOT_FOUND,
    phone_or_contact_form: NOT_FOUND,
    latest_dated_content: NOT_FOUND,
    dns: {
      mx_provider: NOT_FOUND,
      spf_present: NOT_FOUND,
      dmarc_present: NOT_FOUND,
      dmarc_policy: NOT_FOUND,
      dkim: "NOT_CHECKED",
    },
  };
}
