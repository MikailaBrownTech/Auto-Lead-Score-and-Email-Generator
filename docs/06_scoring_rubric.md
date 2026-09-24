# Lead score (0-100). Starting weights; recalibrate after real send results.

The app reads and writes only the config block below (Settings screen). Points must sum to 100. Criterion keys are fixed; labels and points can change.

FIT
- Firm type in target list
- Size signal within the staff range (stated or countable on a team page). No size signal scores 0.
- US and in scope
- Decision maker named publicly

SIGNALS
- No WISP/security mention found on site
- DMARC record missing, or policy=none (from the DNS lookup)
- Personal email domain on the site
- Handles tax, payroll, or credit data (from services)
- Doc exchange language without a mention of a secure portal

REACHABILITY
- Public business email found
- Site appears maintained (dated content within the last N months)
- Phone or contact form present

TIERS: A (write full custom), B (custom email 1 and 2, template the rest), C (template only, or skip). Cutoffs are in the block.

RULE: score only from fields with evidence. NOT_FOUND earns zero points and never counts as a negative finding.

```json clearpath:scoring
{
  "criteria": [
    { "key": "firm_type_in_target", "group": "fit", "label": "Firm type in target list", "points": 15 },
    { "key": "size_in_range", "group": "fit", "label": "Size signal within staff range", "points": 10 },
    { "key": "us_in_scope", "group": "fit", "label": "US and in scope", "points": 5 },
    { "key": "decision_maker_named", "group": "fit", "label": "Decision maker named publicly", "points": 10 },
    { "key": "no_wisp_mention", "group": "signals", "label": "No WISP/security mention found on site", "points": 10 },
    { "key": "dmarc_missing_or_none", "group": "signals", "label": "DMARC record missing, or policy=none", "points": 10 },
    { "key": "personal_email_domain", "group": "signals", "label": "Personal email domain on the site", "points": 5 },
    { "key": "sensitive_data_services", "group": "signals", "label": "Handles tax, payroll, or credit data", "points": 10 },
    { "key": "doc_exchange_without_portal", "group": "signals", "label": "Doc exchange language without a secure portal", "points": 5 },
    { "key": "public_business_email", "group": "reachability", "label": "Public business email found", "points": 10 },
    { "key": "site_maintained", "group": "reachability", "label": "Site appears maintained", "points": 5 },
    { "key": "phone_or_contact_form", "group": "reachability", "label": "Phone or contact form present", "points": 5 }
  ],
  "tiers": { "A": 70, "B": 50 },
  "target_firm_types": ["cpa", "tax_preparer", "bookkeeper", "payroll", "credit_counseling", "collections"],
  "staff_range": { "min": 3, "max": 30 },
  "site_maintained_months": 12,
  "sensitive_data_keywords": ["tax", "payroll", "credit", "debt", "collection"],
  "personal_email_domains": [
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "aol.com", "hotmail.com", "outlook.com",
    "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "sbcglobal.net",
    "verizon.net", "protonmail.com", "proton.me"
  ]
}
```
