# Email sequences (human-written templates)

The model writes only {{personal_line}}. Everything else is fixed copy. Edit anything in [brackets] before sending.

## Merge fields

- {{firm}}: firm name as on the site
- {{firm_short}}: firm name without legal suffixes (LLC, LLP, PLLC, Inc, P.C.)
- {{city}}, {{region}}: city, and your target region such as "Cleveland-area"
- {{personal_line}}: one sentence from the model (max 30 words, verified facts only)
- {{approved_sentence}}: one sentence from a VERIFIED line in docs/02, inserted verbatim
- {{company}}, {{offer}}, {{booking_link}}, {{signature}}, {{first_name}}

## Fallback personal lines (used if the model line fails validation)

- cpa: "Firms like yours handle a lot of sensitive client financial information."
- tax_preparer: "Tax preparers hold some of the most sensitive data there is: SSNs, bank details, prior-year returns."
- bookkeeper: "With remote access to clients' books and bank feeds, a lot rides on how those logins are protected."
- payroll: "Payroll means holding employee SSNs and bank details for every client."

## Greeting rules

- No named contact tied to the address: email 1 opens with the role-based line below. Emails 2 to 5 have no greeting line.
- Named contact tied to the address: email 1 opens "Hi {{first_name}}," and skips the role-based line.

## Email 1 (day 0)

Subject A: written security plan at {{firm_short}}?
Subject B: quick question about client data

Quick question for whoever looks after IT and client data at {{firm}}:

{{personal_line}}

Has anyone asked you for a written information security plan yet, whether an insurer, a bank, or a client?

I ask because I help small accounting and tax firms get that paperwork, and the basic security behind it, sorted without hiring an IT team. If that's not your area, I'd be grateful if you could point me to who handles it.

{{signature}}

## Email 2 (day 3, same thread, no greeting)

Here's something more useful than a "just checking in."

Small firms are generally expected to have four things:

- A written plan for how client data is protected
- One named person responsible for it
- Multi-factor authentication on email and key systems
- A plan for what happens if something goes wrong

{{approved_sentence}}

It's common for firms to have pieces of this in someone's head but not on paper. Is that close to where you are?

{{signature}}

## Email 3 (day 7, same thread)

Subject (if a new thread): one-page checklist for {{firm_short}}

I turned those four points into a one-page checklist in plain language, so you can check your firm against it in about ten minutes.

It's free, with no call and no pitch attached. Want me to send it? Just reply "checklist."

{{signature}}

Sends only when checklist_ready is true in docs/01.

## Email 4 (day 12)

Subject: helping a few firms in {{region}} first

I'm launching {{company}} now, so I'm working with a small first group of {{region}} firms at a founding-client rate: {{offer}}. In return, I ask for honest feedback along the way.

If that sounds useful, would you be open to a 15-minute call? Here's my calendar: {{booking_link}}. If the timing is bad with busy season coming, tell me when to circle back and I will.

{{signature}}

## Email 5 (day 18, same thread)

Subject (if a new thread): closing the loop

I haven't heard back, so I'll assume this isn't a priority right now. That's completely fine.

If a client or insurer does ask about a security plan later, reply and I'll send the checklist right over. Either way, I hope busy season goes smoothly.

{{signature}}

## Segment swaps

| Type | Email 3 hook (subject) | Notes |
|---|---|---|
| cpa | one-page checklist for {{firm_short}} | default sequence |
| tax_preparer | one-page checklist for tax preparers | emphasize SSNs, bank details, prior-year returns |
| bookkeeper | one-page checklist for bookkeeping firms | emphasize remote access and bank feeds |
| payroll | one-page checklist for payroll firms | emphasize employee SSNs and bank details |

## Signature block

{{sender_name}}
{{sender_title}}, {{company}}
{{website}}

{{opt_out_line}}
{{physical_address}}

## Rules that still apply

- No claims of clients, results, or certifications that are not in APPROVED_PROOF (docs/01).
- Email 4 may say you are launching and offering a founding-client rate. Nothing more about traction.
- No penalty amounts. No statements about the prospect's own compliance status.
- Regulatory statements come only from {{approved_sentence}}.
