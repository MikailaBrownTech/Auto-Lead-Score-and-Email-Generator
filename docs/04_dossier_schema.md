# Dossier schema

A fact is {"value": ..., "evidence_url": "...", "evidence_quote": "max 15 words"} or the string "NOT_FOUND". List facts (services, software_mentioned) are plain lists from the model; the code searches the cleaned page text for each item and stores {"value": [...], "evidence": [{"item", "evidence_url"}]} with the page each item was found on. Items not found on any page are dropped.

```json
{
  "lead_id": "L1",
  "source": "web",
  "url": "",
  "domain": "",
  "pages_opened": [],
  "failures": [],
  "prompt_injection_flag": false,
  "injection_findings": [],
  "declined_automated_access": false,
  "firm_name_candidates": [],
  "firm_name": {},
  "firm_type": {},
  "location": {},
  "size_signal": {},
  "client_count_signal": {},
  "services": {},
  "software_mentioned": {},
  "client_portal_or_doc_exchange": {},
  "people": [],
  "public_contact_email": {},
  "personal_email_domain_on_site": {},
  "privacy_policy_present": {},
  "security_or_wisp_mention": {},
  "phone_or_contact_form": {},
  "exclusion_signals": [],
  "decision_maker": {},
  "public_email_kind": "NOT_FOUND",
  "email_security_hint": "NOT_FOUND",
  "portal_mention_search": "NOT_CHECKED",
  "latest_dated_content": {},
  "us_location": {},
  "target_industry_fit": {},
  "gate": {},
  "dns": {
    "mx_provider": {},
    "no_domain_email": {},
    "spf_present": {},
    "dmarc_present": {},
    "dmarc_policy": {},
    "dkim": "NOT_CHECKED"
  },
  "security_mention_search": "NOT_CHECKED"
}
```

Filled by the model from page text (every value must be supported by its own quote):
- firm_name: text. The name must appear in the quote. The quote may be copied from the page body or from the page title. The code lists name candidates from the homepage markup (JSON-LD Organization name, og:site_name, the title before its separator); confirm one when a page supports it.
- firm_type: {"primary", "secondary": []}; types are cpa, tax_preparer, bookkeeper, payroll, credit_counseling, collections, credit_repair, other. The quote must contain a keyword for the primary type (docs/06 evidence block). Secondary types are kept only when the verified services list shows them. Credit repair is its own type, never credit_counseling.
- location: {"city", "state", "country"}; any part may be null. The city must appear in the quote.
- size_signal: {"staff_count": number or null, "text"}: people who work at the firm only; the number must appear in the quote. A quote that counts clients, companies, or returns (and not staff) is moved by code to client_count_signal.
- client_count_signal: {"count": number or null, "text"}: clients or companies served. Recorded only; never scored and never used as staff size.
- services, software_mentioned: plain lists of items copied exactly as a page writes them. No quotes. The code keeps an item only if it finds it in the cleaned text of a fetched page, and keeps the first 25 found; a longer list is never rejected.
- client_portal_or_doc_exchange: {"doc_exchange": true or null, "secure_portal": true or null}. The model never answers false; "no portal" comes from the code's portal keyword search (portal_mention_search).
- people: up to 5 × {"name", "title" (or null), "evidence_url", "evidence_quote"}; name and title must appear in the quote. Empty list if none.
- public_contact_email: {"address", "owner_name"}; the address must appear in the quote. owner_name is the person the same quote ties the address to, or null.
- personal_email_domain_on_site: an address at a consumer provider, used as a firm address; it must appear in the quote.
- privacy_policy_present: true (with a quote) or NOT_FOUND. Never false: only code may record an absence.
- security_or_wisp_mention: text where the firm describes its OWN data-security practices for client information (a WISP, a security program, encrypted client file exchange, safeguards). IT, audit, or assurance services the firm sells to clients do not count.
- phone_or_contact_form: {"phone": text or null, "contact_form": true or null}; the phone digits must appear in the quote.
- exclusion_signals: list of {"signal", "evidence_url", "evidence_quote"}; signal is government_or_nonprofit_only, non_us, individual_practitioner, not_a_firm, closed_or_acquired, or other. Empty list if none.

Filled by code (never by the model):
- firm_type.source: "model" when the model's quote verified; "code" when it did not and the code derived the type from the docs/06 firm_type_keywords (verified services and full page text) with a verbatim quote.
- email_security_hint: INTERNAL ONLY. DMARC rua/ruf report domains that are outside the firm's domain and not on config/dmarc-vendors.json ("possible existing IT provider"). Never sent to the writer, never in emails.
- portal_mention_search: like security_mention_search, for docs/06 portal_keywords.
- decision_maker: {"name", "title", "role_confirmed"}, chosen from people by the docs/06 title preference list. role_confirmed is false when the title is not on the list.
- public_email_kind: named_person (the quote names the owner, or the address is built from a named person's name), generic_inbox (docs/06 generic_inbox_prefixes), or unattributed.
- firm_name_candidates: [{"source": jsonld_organization | og_site_name | title, "value"}] from the homepage markup.
- declined_automated_access: true when the site answered HTTP 403 or 429. No further requests go to that host in the run, nothing is retried, and the user agent is never changed. The UI asks for pasted text instead.
- latest_dated_content: {"date", "source"} from machine-readable dates only (<time datetime>, article:published_time, JSON-LD datePublished/dateModified, sitemap lastmod), or, only when none exist, a /YYYY/MM/DD/ date in a page or sitemap URL path (source url_date, lower confidence). Copyright years, "founded" dates, and policy-page dates never count. evidence_url is the page or sitemap the date came from.
- us_location: {"value": true/false/null, "reason"} from the verified location.
- target_industry_fit: {"value": true/false/null, "reason", "qualifying_type"} from firm type and services with the docs/06 keyword lists.
- gate: {"status": qualified, out_of_icp, or needs_review, "reasons": []}. No sequence is written for out_of_icp or needs_review until the founder approves.
- dns: filled from DNS lookups. no_domain_email is true when the domain definitively has no MX records. Evidence_url is "dns:<TYPE> <name>" and the quote is the record text or a note that no record exists. Lookup failures are NOT_FOUND and listed in failures.
- security_mention_search: "NOT_CHECKED", or {keywords, pages: [{url, kind, http_status, content_type, truncated, text_chars, sha256}], matches: [{url, keyword}]}. It searches the full cleaned text of every page opened.
- injection_findings: {url, where: "visible" | "hidden" | "model", snippet}. "hidden" covers display:none text, aria-hidden text, and HTML comments; hidden text is never sent to the model and never used as evidence. prompt_injection_flag is true when the list is not empty.

Evidence rules:
- evidence_url is a page listed in pages_opened, or "pasted" when source is "pasted".
- evidence_quote is copied exactly from that page's text, 15 words or fewer, one contiguous span.
- A quote containing family or personal details (docs/06 personal_terms) is rejected and a professional quote is requested instead.
- Quotes are for verification only and are never passed to the writer; the writer sees values only.

Notes:
- source is "web" (fetched pages) or "pasted" (a LinkedIn bio or About-page copy pasted by the user; it is then the only source of facts).
- pages_opened lists only pages actually fetched with HTTP 200 and an HTML content type.
- dns.dkim is always NOT_CHECKED. Never claim DKIM status.
