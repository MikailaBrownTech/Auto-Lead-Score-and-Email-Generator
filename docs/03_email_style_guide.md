# Email style guide

STRUCTURE: the emails are human-written templates in docs/09_sequences.md; code fills the merge fields and the model writes only {{personal_line}} (one sentence). Email 1 greets by first name only when the public address is tied to that person, otherwise it opens with the role-based line; emails 2 to 5 have no greeting. The signature block, opt-out line and address come from docs/09 and docs/01.

TONE: plain, peer-to-peer, specific. Sounds like a person typed it in two minutes.

BANNED: "I hope this finds you well", "game-changer", "revolutionary", "cutting-edge", "synergy", "quick call" (as the ask), exclamation marks, emojis, ALL CAPS, fake urgency, threats about fines, fake "Re:" on the first email, invented familiarity ("loved your post").

SUBJECTS: lowercase, short (word limit in the block below), specific, not clickbait. Example: "wisp for {{firm_name}}".

PERSONALIZATION RULE: one specific, verified detail from the dossier per email, max. Never stack many details (it reads as surveillance).

SECURITY OBSERVATIONS: max one per email, hedged, non-accusatory, and only if evidence exists. Never state that the firm lacks a WISP or plan; we cannot know that. Ask instead.

CLAIM SAFETY: no guarantees (compliance, security, protection from fines), no false authority (government approval, unapproved credentials), no urgency.

LINKS: max one per email, none in email 1 if possible. The only link allowed is booking_link in docs/01.

FIRM-TYPE ANGLES:
- CPA: insurer renewals, client data, busy season.
- Tax preparer: IRS Pub 4557 / WISP.
- Bookkeeper: remote access, portals, Microsoft 365.
- Payroll: PII, vendor oversight.
- Collections / credit: audit trails, documented access.

SEQUENCE: the copy lives in docs/09_sequences.md (send days and word limits are in the block below). One question mark per email at most.

EXAMPLE, email 1 (format only; details are placeholders):

Subject: wisp for {{firm_name}}
Hi {{first_name}},
Noticed {{firm_name}} handles {{verified_service}} for clients in {{city}}. Firms like that generally need a written information security plan under the FTC Safeguards Rule. Do you already have one in place?
{{sender_name}}
{{opt_out_line}}
{{physical_address}}

BAD example: "I was impressed by your firm's incredible growth!" (unverifiable, flattery, sounds automated).

## Settings used by the app

The app reads and writes only the block below (Settings screen). Validators enforce it in code.

- word_limits: max words per email body, emails 1 to 5 (greeting or opening line through the last sentence before the sign-off; the signature block, opt-out line and address are not counted). Bullet lists are allowed (email 2 uses one).
- subject_max_words: max words per subject line. The firm's name (full or short) and the region do not count.
- evaluative_terms: words that judge or flatter the firm. The model-written {{personal_line}} may not contain them (nor banned_phrases, absence claims, regulatory or insurer statements).
- banned_phrases: matched case-insensitively. Exclamation marks, emojis, ALL CAPS words (other than allowed_acronyms), leftover placeholders, and "Re:"/"Fwd:" on the first subject are always blocked.
- proof_patterns: phrases that claim clients, results, or credentials. Blocked unless the sentence also contains an approved_proof item from docs/01.
- absence_claims: a sentence containing one of the negations and one of the plan_terms ("you don't have a WISP") is blocked. Questions and sentences starting with "if" or "whether" are exempt.
- firm_type_angles: the fixed list of angles a sequence can be tagged with (used by the Results screen).

```json clearpath:style
{
  "send_days": [
    0,
    3,
    7,
    12,
    18
  ],
  "word_limits": {
    "1": 130,
    "2": 140,
    "3": 100,
    "4": 130,
    "5": 75
  },
  "subject_max_words": 6,
  "max_links_per_email": 1,
  "max_personal_details_per_email": 1,
  "banned_phrases": [
    "I hope this finds you well",
    "hope this email finds you well",
    "game-changer",
    "game changer",
    "revolutionary",
    "cutting-edge",
    "cutting edge",
    "synergy",
    "quick call",
    "loved your post",
    "saw your post",
    "big fan of",
    "act now",
    "limited time",
    "last chance",
    "urgent",
    "don't miss out",
    "before it's too late",
    "you could be fined",
    "facing fines",
    "penalties of up to",
    "fines of up to",
    "guaranteed compliance",
    "guarantee compliance",
    "guaranteed secure",
    "we'll make you compliant",
    "we will make you compliant",
    "100% secure",
    "100% compliant",
    "protects you from fines",
    "protect you from fines",
    "FTC-approved",
    "FTC approved",
    "IRS-approved",
    "IRS approved",
    "government-approved",
    "final notice",
    "good sign",
    "to-do list",
    "todo list",
    "falling behind",
    "fall behind",
    "you're behind",
    "you are behind",
    "not compliant",
    "non-compliant",
    "noncompliant",
    "at risk",
    "exposed"
  ],
  "allowed_acronyms": [
    "WISP",
    "IRS",
    "FTC",
    "CPA",
    "CPAS",
    "PII",
    "MFA",
    "IT",
    "US",
    "EFIN",
    "PTIN",
    "SSN",
    "HUD",
    "FDCPA",
    "SPF",
    "DMARC",
    "DKIM",
    "MX",
    "LLC",
    "PDF"
  ],
  "proof_patterns": [
    "our clients",
    "clients like you",
    "we helped",
    "we've helped",
    "we have helped",
    "case study",
    "trusted by",
    "firms we work with",
    "we work with",
    "results for",
    "certified",
    "certification"
  ],
  "absence_claims": {
    "negations": [
      "don't have",
      "do not have",
      "doesn't have",
      "does not have",
      "haven't",
      "hasn't",
      "has not",
      "lack",
      "lacks",
      "lacking",
      "missing",
      "without",
      "no"
    ],
    "plan_terms": [
      "wisp",
      "written information security",
      "information security plan",
      "information security program",
      "security plan",
      "security program",
      "written plan",
      "security policy",
      "incident response plan"
    ]
  },
  "evaluative_terms": [
    "impressive",
    "impressed",
    "great",
    "excellent",
    "amazing",
    "incredible",
    "outstanding",
    "strong",
    "solid",
    "reputation",
    "clearly",
    "obviously",
    "well-run",
    "leading",
    "best",
    "top-rated",
    "trusted",
    "award",
    "admire",
    "love",
    "loved",
    "vulnerable",
    "risky",
    "outdated",
    "weak",
    "behind",
    "should"
  ],
  "firm_type_angles": {
    "cpa": [
      "insurer_renewals",
      "client_data",
      "busy_season"
    ],
    "tax_preparer": [
      "irs_pub_4557_wisp"
    ],
    "bookkeeper": [
      "remote_access",
      "client_portals",
      "microsoft_365"
    ],
    "payroll": [
      "pii",
      "vendor_oversight"
    ],
    "credit_counseling": [
      "audit_trails",
      "documented_access"
    ],
    "collections": [
      "audit_trails",
      "documented_access"
    ],
    "credit_repair": [
      "written_security_plan"
    ],
    "other": [
      "written_security_plan"
    ]
  }
}
```
