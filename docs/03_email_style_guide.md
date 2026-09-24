# Email style guide

STRUCTURE: greeting by first name if known (otherwise "Hi,"), 1 observation or question, 1 point of value, 1 CTA, sign-off with sender name, then {{opt_out_line}} and {{physical_address}}.

TONE: plain, peer-to-peer, specific. Sounds like a person typed it in two minutes.

BANNED: "I hope this finds you well", "game-changer", "revolutionary", "cutting-edge", "synergy", "quick call" (as the ask), exclamation marks, emojis, ALL CAPS, fake urgency, threats about fines, fake "Re:" on the first email, invented familiarity ("loved your post").

SUBJECTS: lowercase, short (word limit in the block below), specific, not clickbait. Example: "wisp for {{firm_name}}".

PERSONALIZATION RULE: one specific, verified detail from the dossier per email, max. Never stack many details (it reads as surveillance).

SECURITY OBSERVATIONS: max one per email, hedged, non-accusatory, and only if evidence exists.

LINKS: max one per email, none in email 1 if possible. The only link allowed is the CTA link in docs/01.

FIRM-TYPE ANGLES:
- CPA: insurer renewals, client data, busy season.
- Tax preparer: IRS Pub 4557 / WISP.
- Bookkeeper: remote access, portals, Microsoft 365.
- Payroll: PII, vendor oversight.
- Collections / credit: audit trails, documented access.

SEQUENCE (send days and word limits are in the block below):
1. Custom observation plus one question
2. One Safeguards/IRS requirement relevant to their firm type plus one custom detail
3. Offer the 2-minute scorecard, or a public-exposure snapshot if verified findings exist
4. Approved founding-client offer if one exists, otherwise a useful checklist
5. Break-up, a few sentences

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

- word_limits: max words per email body (greeting through the last sentence before the sign-off; the sign-off, opt-out line and address are not counted). Email 5 is limited by sentence count instead.
- banned_phrases: matched case-insensitively. Exclamation marks, emojis, ALL CAPS words (other than allowed_acronyms), leftover placeholders, and "Re:"/"Fwd:" on the first subject are always blocked.
- proof_patterns: phrases that claim clients, results, or credentials. Blocked unless the sentence also contains an approved_proof item from docs/01.
- firm_type_angles: the fixed list of angles a sequence can be tagged with (used by the Results screen).

```json clearpath:style
{
  "send_days": [0, 3, 7, 12, 18],
  "word_limits": { "1": 75, "2": 90, "3": 90, "4": 80 },
  "breakup_sentences": { "min": 2, "max": 3 },
  "subject_max_words": 5,
  "max_links_per_email": 1,
  "max_personal_details_per_email": 1,
  "banned_phrases": [
    "I hope this finds you well", "hope this email finds you well", "game-changer", "game changer",
    "revolutionary", "cutting-edge", "cutting edge", "synergy", "quick call",
    "loved your post", "saw your post", "big fan of", "act now", "limited time", "last chance",
    "urgent", "don't miss out", "before it's too late", "you could be fined", "facing fines",
    "penalties of up to", "fines of up to"
  ],
  "allowed_acronyms": [
    "WISP", "IRS", "FTC", "CPA", "CPAS", "PII", "MFA", "IT", "US", "EFIN", "PTIN", "SSN", "HUD",
    "FDCPA", "SPF", "DMARC", "DKIM", "MX", "LLC", "PDF"
  ],
  "proof_patterns": [
    "our clients", "clients like you", "we helped", "we've helped", "we have helped", "case study",
    "trusted by", "firms we work with", "we work with", "results for", "certified", "certification"
  ],
  "firm_type_angles": {
    "cpa": ["insurer_renewals", "client_data", "busy_season"],
    "tax_preparer": ["irs_pub_4557_wisp"],
    "bookkeeper": ["remote_access", "client_portals", "microsoft_365"],
    "payroll": ["pii", "vendor_oversight"],
    "credit_counseling": ["audit_trails", "documented_access"],
    "collections": ["audit_trails", "documented_access"],
    "other": ["written_security_plan"]
  }
}
```
