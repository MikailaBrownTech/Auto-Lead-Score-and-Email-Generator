# Lead score (0-100). Starting weights; recalibrate after real send results.

The app reads and writes only the two config blocks below (Settings screen). Criterion keys are fixed; labels, points, thresholds, and lists can change. Points must sum to 100.

FIT (computed first)
- Firm type in target list: the primary type, or a secondary type that the verified services list shows (keywords in the evidence block). credit_repair is not a target type; a credit repair firm qualifies only through a secondary target type such as tax_preparer.
- Target industry fit: computed by code from firm type and services with the firm_type_keywords lists. The model never decides scope.
- US location: computed by code from the verified location.
- Size signal within the staff range (stated or countable on a team page). No size signal scores 0.
- Decision maker named publicly: the code picks from the named people using decision_maker_title_preferences. Full points only when the title is on that list; otherwise partial_points.decision_maker_role_unconfirmed and a role_unconfirmed flag.

GATES (no sequence is written for a gated lead until the founder approves it)
- out_of_icp: staff_count above max_staff_for_sequence, or target industry fit is false.
- needs_review: the model reported any exclusion signal (government/nonprofit-only, non-US, individual practitioner, and so on), each with a quote. Visible in the UI and overridable.

SIGNALS (count only when the fit gates pass; an out_of_icp lead gets 0 signal points)
- No WISP/security mention found on site. Scored only from the code's keyword search of the full cleaned page text (not the token-capped copy sent to the model), never from the LLM. Needs the homepage plus a privacy or security page, or at least wisp_min_pages complete pages, each fetched as HTTP 200 HTML (not truncated, not near-empty), and none of the wisp_keywords may appear. The searched URLs, keywords, and content hashes are recorded as the evidence.
- DMARC record missing, or policy=none (from the DNS lookup). Scored only when the domain has MX records. A domain with no MX is recorded as no_domain_email and gets no DMARC points. Lookup failures (timeout, SERVFAIL) are never scored; only a definitive answer (NXDOMAIN/NODATA or a record) counts.
- Personal email domain on the site
- Handles tax, payroll, or credit data (from services)
- Doc exchange language without a mention of a secure portal. The model may only report document exchange or a portal as present (true, with a quote). "No portal" comes from the code's keyword search (portal_keywords) of the full page text, with the same page minimum as the WISP search.

REACHABILITY
- Public business email found: full points when the address is tied to a named person (the same quote names them, or the address is built from their name); partial_points.public_business_email_generic for a generic inbox (generic_inbox_prefixes: info@, office@, contact@ ...) or an address not tied to anyone. A generic inbox is never greeted by name.
- Site appears maintained: machine-readable dates only (<time datetime>, article:published_time, JSON-LD datePublished/dateModified, sitemap lastmod) within the last N months. A /YYYY/MM/DD/ date in a page or sitemap URL path (url_date) is lower confidence and used only when none of those exist. Copyright years, "founded" dates, and policy-page "last updated" dates never count.
- Phone or contact form present

TIERS: A (write full custom), B (custom email 1 and 2, template the rest), C (template only, or skip). Cutoffs are in the block. If the fit points are below fit_threshold, the tier is capped at C.

RULE: score only from fields with evidence. NOT_FOUND earns zero points and never counts as a negative finding. The one absence-based signal (no WISP/security mention) is evidenced by the recorded keyword search above, not by NOT_FOUND. It is for scoring only: emails must never claim the firm lacks a WISP or plan.

```json clearpath:scoring
{
  "criteria": [
    {
      "key": "firm_type_in_target",
      "group": "fit",
      "label": "Firm type in target list (primary, or a secondary type shown in services)",
      "points": 10
    },
    {
      "key": "target_industry_fit",
      "group": "fit",
      "label": "Target industry fit (computed from firm type and services)",
      "points": 5
    },
    {
      "key": "us_location",
      "group": "fit",
      "label": "US location",
      "points": 5
    },
    {
      "key": "size_in_range",
      "group": "fit",
      "label": "Size signal within staff range",
      "points": 10
    },
    {
      "key": "decision_maker_named",
      "group": "fit",
      "label": "Decision maker named publicly",
      "points": 10
    },
    {
      "key": "no_wisp_mention",
      "group": "signals",
      "label": "No WISP/security mention found on site",
      "points": 10
    },
    {
      "key": "dmarc_missing_or_none",
      "group": "signals",
      "label": "DMARC record missing, or policy=none (domain has email)",
      "points": 10
    },
    {
      "key": "personal_email_domain",
      "group": "signals",
      "label": "Personal email domain on the site",
      "points": 5
    },
    {
      "key": "sensitive_data_services",
      "group": "signals",
      "label": "Handles tax, payroll, or credit data",
      "points": 10
    },
    {
      "key": "doc_exchange_without_portal",
      "group": "signals",
      "label": "Doc exchange language without a secure portal",
      "points": 5
    },
    {
      "key": "public_business_email",
      "group": "reachability",
      "label": "Public business email found",
      "points": 10
    },
    {
      "key": "site_maintained",
      "group": "reachability",
      "label": "Site appears maintained (machine-readable dates)",
      "points": 5
    },
    {
      "key": "phone_or_contact_form",
      "group": "reachability",
      "label": "Phone or contact form present",
      "points": 5
    }
  ],
  "tiers": {
    "A": 70,
    "B": 50
  },
  "fit_threshold": 20,
  "max_staff_for_sequence": 60,
  "target_firm_types": [
    "cpa",
    "tax_preparer",
    "bookkeeper",
    "payroll",
    "credit_counseling",
    "collections"
  ],
  "staff_range": {
    "min": 3,
    "max": 30
  },
  "site_maintained_months": 12,
  "sensitive_data_keywords": [
    "tax",
    "payroll",
    "credit",
    "debt",
    "collection"
  ],
  "personal_email_domains": [
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "ymail.com",
    "aol.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "comcast.net",
    "att.net",
    "sbcglobal.net",
    "verizon.net",
    "protonmail.com",
    "proton.me",
    "roadrunner.com",
    "rr.com",
    "wowway.com"
  ],
  "wisp_keywords": [
    "wisp",
    "written information security",
    "information security program",
    "information security plan",
    "security program",
    "security policy",
    "safeguards rule",
    "data security",
    "cybersecurity",
    "cyber security",
    "encryption",
    "encrypted",
    "multi-factor",
    "two-factor",
    "secure file",
    "protect your data",
    "protecting your information"
  ],
  "wisp_search_min_text_chars": 200,
  "wisp_min_pages": 3,
  "portal_keywords": [
    "portal",
    "secure upload",
    "upload documents",
    "upload your documents",
    "sharefile",
    "smartvault",
    "liscio",
    "taxdome",
    "canopy",
    "verifyle",
    "suralink",
    "netclient",
    "onvio"
  ],
  "partial_points": {
    "public_business_email_generic": 5,
    "decision_maker_role_unconfirmed": 5
  }
}
```

## Evidence lists

- firm_type_keywords: a firm_type quote must contain a keyword for the primary type. The same lists find secondary types in the verified services, and decide target industry fit.
- personal_terms: an evidence quote containing any of these (family and personal details) is rejected and a professional quote is requested instead. Quotes are never passed to the writer.
- decision_maker_title_preferences: the decision maker is the named person whose title matches the earliest entry.
- generic_inbox_prefixes: local parts (before the @) of shared role inboxes.

```json clearpath:evidence
{
  "firm_type_keywords": {
    "cpa": [
      "cpa",
      "cpas",
      "certified public accountant",
      "certified public accountants",
      "accounting firm",
      "public accounting",
      "audit",
      "assurance",
      "auditing",
      "auditors",
      "accountants"
    ],
    "tax_preparer": [
      "tax preparation",
      "tax preparer",
      "tax preparers",
      "tax prep",
      "tax return",
      "tax returns",
      "income tax",
      "tax filing",
      "tax services",
      "enrolled agent"
    ],
    "bookkeeper": [
      "bookkeeping",
      "bookkeeper",
      "bookkeepers",
      "accounts payable",
      "bank reconciliation"
    ],
    "payroll": [
      "payroll"
    ],
    "credit_counseling": [
      "credit counseling",
      "credit counselor",
      "credit counselors",
      "debt management",
      "financial counseling",
      "housing counseling"
    ],
    "collections": [
      "collection agency",
      "collections agency",
      "debt collection",
      "debt recovery",
      "accounts receivable management",
      "collections"
    ],
    "credit_repair": [
      "credit repair",
      "credit restoration",
      "remove negatives",
      "credit report dispute",
      "credit disputes"
    ]
  },
  "personal_terms": [
    "wife",
    "husband",
    "mother",
    "mom",
    "father",
    "dad",
    "kids",
    "children",
    "child",
    "boys",
    "girls",
    "son",
    "sons",
    "daughter",
    "daughters",
    "married",
    "marriage",
    "pregnant",
    "baby",
    "church",
    "faith",
    "god",
    "pastor",
    "ministry",
    "grandmother",
    "grandfather",
    "grandkids",
    "grandchildren",
    "divorce",
    "divorced",
    "widow",
    "cancer",
    "diagnosis"
  ],
  "decision_maker_title_preferences": [
    "managing partner",
    "owner",
    "founder",
    "president",
    "ceo",
    "managing member",
    "principal",
    "shareholder",
    "partner",
    "firm administrator",
    "office manager",
    "coo"
  ],
  "generic_inbox_prefixes": [
    "info",
    "office",
    "contact",
    "contactus",
    "admin",
    "hello",
    "mail",
    "email",
    "marketing",
    "sales",
    "support",
    "help",
    "team",
    "staff",
    "frontdesk",
    "front.desk",
    "reception",
    "inquiries",
    "inquiry",
    "enquiries",
    "general",
    "service",
    "services",
    "clients",
    "billing",
    "accounts",
    "accounting",
    "bookkeeping",
    "tax",
    "taxes",
    "payroll",
    "hr",
    "careers",
    "jobs",
    "noreply",
    "no-reply",
    "webmaster"
  ]
}
```
