# Email style guide

STRUCTURE: the writer model writes all five emails (tiers A and B) in the voice of the example sequences at the end of this file. Email 1 greets by first name only when the public address is tied to that person; otherwise it opens with a role-based line ("Not sure who's the right person for this..." / "Quick question for whoever handles this at <firm>:"), never "Hi there,". Emails 2 to 5 are in the same thread and have no greeting. The app adds the signature block, opt-out line, and address from docs/01. Tier C leads get the fixed docs/09_sequences.md copy instead (no model call).

TONE: plain, peer-to-peer, specific, conversational. Sounds like a person typed it in two minutes. Questions instead of judgments.

BANNED: "I hope this finds you well", "game-changer", "revolutionary", "cutting-edge", "synergy", "quick call" (as the ask), "Hi there,", exclamation marks, emojis, ALL CAPS, fake urgency, threats about fines, fake "Re:" on the first email, invented familiarity ("loved your post").

SUBJECTS: lowercase except the firm's name, short (word limit in the block below), specific, not clickbait. Email 1 has two (A and B).

PERSONALIZATION (guidance, not a hard limit): use the lead's verified details naturally, usually one per email, sometimes two when that is how a person would write it. Never stack many details (it reads as surveillance). Never mention people other than the greeting, or anything personal.

QUESTIONS (guidance): usually one per email; two is fine when natural (for example a question plus "could you point me to who handles it?").

REGULATORY RULE (hard, enforced in code): the writer never writes a sentence that says what a law or rule requires, and never states penalties. It may refer to "the requirement" or "what's usually expected" without naming the rule. Where the requirement belongs (email 2), it writes the marker [[APPROVED]] on its own line and the app inserts the exact VERIFIED docs/02 sentence there.

CLAIM SAFETY: no guarantees (compliance, security, protection from fines), no false authority (government approval, unapproved credentials), no claims of clients, results, or traction beyond approved_proof in docs/01, no urgency, no evaluation of the prospect (never "that's a good sign", "you're behind").

LINKS: max one per email, none in email 1 if possible. The only link allowed is booking_link in docs/01.

FIRM-TYPE ANGLES:
- CPA: insurer renewals, client data, busy season.
- Tax preparer: IRS Pub 4557 / WISP.
- Bookkeeper: remote access, portals, Microsoft 365.
- Payroll: PII, vendor oversight.
- Collections / credit: audit trails, documented access.

SEQUENCE SHAPE (send days and word limits are in the block below): 1 a direct question about a written security plan and why it comes up; 2 the short list of what's usually expected plus the [[APPROVED]] sentence; 3 the one-page checklist by reply; 4 the founding-client offer and the booking link; 5 a short, gracious close.

BAD example: "I was impressed by your firm's incredible growth!" (unverifiable, flattery, sounds automated).

## Settings used by the app

The app reads and writes only the block below (Settings screen). Validators enforce it in code.

- word_limits: max words per email body, emails 1 to 5 (greeting or opening line through the last sentence before the sign-off; the signature block, opt-out line and address are not counted). Bullet lists are allowed.
- subject_max_words: max words per subject line. The firm's name (full or short) and the region do not count.
- banned_phrases: matched case-insensitively. Exclamation marks, emojis, ALL CAPS words (other than allowed_acronyms), leftover placeholders, and "Re:"/"Fwd:" on the first subject are always blocked.
- proof_patterns: phrases that claim clients, results, credentials, or traction. Blocked unless the sentence also contains an approved_proof item from docs/01.
- evaluative_terms: words that judge or flatter the prospect. Blocked in a sentence about the prospect (its name, or "your firm/practice/team/site/security ...").
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
    "2": 150,
    "3": 110,
    "4": 140,
    "5": 60
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
    "exposed",
    "hi there,"
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
    "certification",
    "i do a lot of work with",
    "i work with",
    "i'm working with",
    "i am working with",
    "i've worked with",
    "i have worked with"
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

# Example sequences (few-shot examples for the writer)

These are style examples, not templates to copy verbatim. They show the tone, pacing, and how a real approved sentence gets woven in naturally. The model should write NEW text in this voice for each lead, using that lead's own verified facts. Bracketed items are placeholders: the writer fills them from the lead's facts and the docs/01 settings, and never writes brackets. The [Sender Name] line stands for the signature block the app adds.

Notes on what makes these work, for whoever tunes the prompt later:
- Each email sounds like a specific person wrote it in two minutes, not like a system assembled it.
- Only one sentence per sequence states what the law requires, and it is lifted word for word from an approved docs/02 line (marked below). Everything else paraphrases loosely around it or asks a question instead of asserting a fact.
- Details about the firm are used naturally, sometimes more than one per email, because that's how people actually write.
- No email evaluates the prospect ("that's a good sign," "you're behind"). Questions are used instead of judgments.

---

## EXAMPLE A: CPA firm, named contact, decision-maker known

Context (for illustration only): a 12-person CPA firm in a mid-size Ohio suburb, does tax prep and small business accounting, decision maker is "Karen," title Managing Partner, address is hers directly.

**Email 1 — day 0**
Subject A: wisp for [Firm Name]
Subject B: quick question about client data

Hi Karen,

There's a question I've been asking small accounting firms in [region], so I figured I'd ask you directly: has anyone, an insurer, a bank, a client, asked [Firm Name] for a written information security plan yet?

Given the tax prep and bookkeeping work you're doing for clients, it's the kind of thing that tends to surface at renewal time or during an audit, if it hasn't already.

I help firms like yours get that documented, and get the basic security behind it in place, without needing to hire IT staff. If it's already handled, no worries at all, just say so and I'll leave you be.

[Sender Name]

**Email 2 — day 3, same thread**

Following up on my note from a few days ago.

Here's the short version of what's usually expected: a written plan for protecting client data, one person named as responsible for it, multi-factor authentication on email and key systems, and a plan for what happens if something goes wrong.

[APPROVED SENTENCE — inserted verbatim from a VERIFIED docs/02 line]

Most firms I talk to have some of this already, just not written down in one place. Curious where things stand for you.

[Sender Name]

**Email 3 — day 7**

I put together a one-page version of that list, in plain language, so you can see where [Firm Name] stands in about ten minutes. No call needed for it.

Want me to send it over?

[Sender Name]

**Email 4 — day 12**

I'm taking on a small group of [region] firms right now at a founding-client rate: [offer details]. Part of the deal is I get honest feedback as I go, which is worth more to me than the discount is a cost.

If it's useful, happy to do a quick 15-minute call: [booking link]. And if the timing's bad with busy season on the horizon, just tell me when to check back and I will.

[Sender Name]

**Email 5 — day 18**

Haven't heard back, so I'll take that as "not right now," which is completely fine.

If a security plan ever comes up, from an insurer, a client, or your own planning, reply here and I'll send that checklist over.

Hope tax season treats you well.

[Sender Name]

---

## EXAMPLE B: Tax preparer, no named contact, generic inbox

Context: a small tax prep shop, 3-5 people, only public address is info@, no owner name found.

**Email 1 — day 0**
Subject A: written security plan at [Firm Name]?
Subject B: a question for whoever handles client data

Not sure who's the right person for this, so apologies if you're not it: does anyone at [Firm Name] currently have a written plan for how client tax information is protected?

I ask because tax preparers end up holding some of the most sensitive data out there, Social Security numbers, bank details, prior returns, and it's become common for that kind of documentation to get asked for, by an insurer, a bank, sometimes a client.

I help small tax and accounting shops put that plan together, along with the basic security it calls for, without needing an in-house IT person. If you're not the one who'd handle this, any chance you could point me to who is?

[Sender Name]

**Email 2 — day 3, same thread**

Wanted to follow up with something more concrete than "just checking in."

What's usually expected is fairly specific: a written data security plan, one named person responsible for it, multi-factor authentication turned on, and a basic plan for what to do if something goes wrong.

[APPROVED SENTENCE — inserted verbatim from a VERIFIED docs/02 line]

A lot of shops have pieces of this already, just not written down anywhere. If that sounds familiar, I can help pull it together.

[Sender Name]

**Email 3 — day 7**

I made a one-page checklist that lays out what's expected, in plain language, so you can check [Firm Name] against it in about ten minutes.

It's free, no strings, no call required. Just reply "checklist" and I'll send it your way.

[Sender Name]

**Email 4 — day 12**

Quick update: I'm taking on a small first group of [region] tax and accounting firms at a founding-client rate right now: [offer details]. In exchange I just ask for honest feedback as we go.

If that's worth a look, I've got time for a short call: [booking link]. Totally understand if timing's rough this close to filing season, just let me know when's better.

[Sender Name]

**Email 5 — day 18**

Haven't heard anything back, so I'll leave it here for now.

If a written security plan ever comes up, reply anytime and I'll get that checklist over to you.

Wishing you a smooth season.

[Sender Name]

---

## EXAMPLE C: Bookkeeping firm, generic detail variation (shows natural flexibility)

Context: a bookkeeping firm, remote-first, mentions a client portal, no named contact.

**Email 1 — day 0**
Subject A: quick question about client access
Subject B: written security plan at [Firm Name]?

Quick question for whoever handles this at [Firm Name]: with clients logging into a portal and sharing bank access, is there a written plan in place for how that data and those logins are protected?

It's the kind of thing that tends to come up eventually, sometimes from a bank, sometimes during a client's own vendor review, and it's a lot easier to have ready than to scramble for.

I help bookkeeping and accounting firms put that documentation together and tighten up the security behind it, without adding a full IT department. If someone else handles this, feel free to just point me their way.

[Sender Name]

**Email 2 — day 3, same thread**

Following up with the actual short list, since "let me know" emails aren't very useful.

What's generally expected: a written data protection plan, someone named as responsible for it, multi-factor authentication on the systems that matter, and a plan for handling anything that goes wrong.

[APPROVED SENTENCE — inserted verbatim from a VERIFIED docs/02 line]

If you've got the portal locked down but nothing written on paper yet, that's a really common spot to be in, and an easy one to fix.

[Sender Name]

**Email 3-5: same shape as Example A/B, adjusted for firm type.**

---

## EXAMPLE D: the founder's original fixed-copy sequence, plainer and more direct

Context: this is the sequence the app used to send as literal, unwritten copy before every tier was written by the model (docs/09). It is here as a style reference only, for its plainer, more direct register, not to be copied verbatim: generic address, no named contact.

**Email 1 — day 0**
Subject A: written security plan at [Firm Name]?
Subject B: quick question about client data

Quick question for whoever looks after IT and client data at [Firm Name]:

Has anyone asked you for a written information security plan yet, whether an insurer, a bank, or a client?

I ask because I help small accounting and tax firms get that paperwork, and the basic security behind it, sorted without hiring an IT team. If that's not your area, I'd be grateful if you could point me to who handles it.

[Sender Name]

**Email 2 — day 3, same thread**

Here's something more useful than a "just checking in."

Small firms are generally expected to have four things: a written plan for how client data is protected, one named person responsible for it, multi-factor authentication on email and key systems, and a plan for what happens if something goes wrong.

[APPROVED SENTENCE — inserted verbatim from a VERIFIED docs/02 line]

It's common for firms to have pieces of this in someone's head but not on paper. Is that close to where you are?

[Sender Name]

**Email 3 — day 7**

I turned those four points into a one-page checklist in plain language, so you can check your firm against it in about ten minutes.

It's free, with no call and no pitch attached. Want me to send it? Just reply "checklist."

[Sender Name]

**Email 4 — day 12**

I'm launching [Sender Company] now, so I'm working with a small first group of [region] firms at a founding-client rate: [offer details]. In return, I ask for honest feedback along the way.

If that sounds useful, would you be open to a 15-minute call? Here's my calendar: [booking link]. If the timing is bad with busy season coming, tell me when to circle back and I will.

[Sender Name]

**Email 5 — day 18, same thread**

I haven't heard back, so I'll assume this isn't a priority right now. That's completely fine.

If a client or insurer does ask about a security plan later, reply and I'll send the checklist right over. Either way, I hope busy season goes smoothly.

[Sender Name]

---

## What to feed the writer prompt

Give the model 2 of these 4 examples (rotate which ones, so it doesn't over-fit to one), plus the current lead's verified dossier values, greeting rule, and the exact approved sentence to splice in. Instruct it explicitly: "Write new text in this voice and structure using the facts provided. Do not copy phrasing from the examples verbatim; they are style references only."
