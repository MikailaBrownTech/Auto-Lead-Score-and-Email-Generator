# Dossier schema

Every field is {"value": ..., "evidence_url": "...", "evidence_quote": "max 15 words"} or the string "NOT_FOUND".

```json
{
  "lead_id": "L1",
  "source": "web",
  "url": "",
  "domain": "",
  "pages_opened": [],
  "failures": [],
  "prompt_injection_flag": false,
  "firm_name": {},
  "firm_type": {},
  "location": {},
  "in_scope": {},
  "size_signal": {},
  "services": {},
  "software_mentioned": {},
  "client_portal_or_doc_exchange": {},
  "decision_maker": {},
  "public_contact_email": {},
  "personal_email_domain_on_site": {},
  "privacy_policy_present": {},
  "security_or_wisp_mention": {},
  "recent_signal": {},
  "phone_or_contact_form": {},
  "latest_dated_content": {},
  "dns": {
    "mx_provider": {},
    "spf_present": {},
    "dmarc_present": {},
    "dmarc_policy": {},
    "dkim": "NOT_CHECKED"
  },
  "security_mention_search": "NOT_CHECKED"
}
```

Value shapes (what goes in "value"):
- firm_name: text.
- firm_type: one of cpa, tax_preparer, bookkeeper, payroll, credit_counseling, collections, other.
- location: {"city", "state", "country"}; any part may be null.
- in_scope: true/false.
- size_signal: {"staff_count": number or null, "text": what the page says}.
- services, software_mentioned: lists of text.
- client_portal_or_doc_exchange: {"doc_exchange": true/false, "secure_portal": true/false}.
- decision_maker: {"name", "title"}; title may be null.
- public_contact_email, personal_email_domain_on_site: an email address shown on the site.
- privacy_policy_present: true/false.
- security_or_wisp_mention: text.
- recent_signal: {"text", "date"}; date as YYYY-MM or YYYY-MM-DD.
- phone_or_contact_form: {"phone": text or null, "contact_form": true/false}.
- latest_dated_content: {"text", "date"}; the most recent dated item on the site (post, news, copyright year does not count), date as YYYY-MM or YYYY-MM-DD.
- dns.mx_provider: text; dns.spf_present, dns.dmarc_present: true/false; dns.dmarc_policy: none, quarantine, or reject.

Evidence:
- evidence_url is a page listed in pages_opened, or "pasted" when source is "pasted".
- evidence_quote is copied exactly from that page's text, 15 words or fewer.
- DNS fields are filled by code, never by the LLM. Their evidence_url is "dns:<TYPE> <name>" (for example "dns:TXT _dmarc.example.com") and the quote is the record text, or a note that no record exists.

Notes:
- source is "web" (fetched pages) or "pasted" (a LinkedIn bio or About-page copy pasted by the user; it is then the only source of facts).
- in_scope means a US business in a target industry.
- size_signal only if stated or countable on a team page.
- personal_email_domain_on_site means gmail, yahoo, aol, etc. used as a firm address.
- recent_signal only if dated (new hire, new service, news).
- phone_or_contact_form: a phone number shown on the site, or a contact form.
- latest_dated_content: used to judge whether the site is maintained.
- dns.dkim is always NOT_CHECKED. Never claim DKIM status.
- security_mention_search is filled by code, not the LLM: "NOT_CHECKED", or {keywords, pages: [{url, kind, http_status, content_type, truncated, text_chars, sha256}], matches: [{url, keyword}]}. It is the evidence for the docs/06 "no WISP/security mention" score. Every searched URL must be in pages_opened.
- pages_opened lists only pages actually fetched with HTTP 200 and an HTML content type.
