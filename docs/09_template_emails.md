# Template emails (DRAFT for founder review)

Used for Tier C leads (all five emails) and Tier B leads (emails 3, 4 and 5). Tier A leads get fully custom emails.

Rules these follow:
- No dossier details, so they are never wrong about the prospect. The only variables are the greeting, the firm name, and the CTA link.
- No proof claims (approved_proof in docs/01 is empty), no pricing, no fear language, no fine amounts.
- Regulatory statements come only from docs/02. Each email notes which docs/02 facts it relies on (quoted by their opening words). Those lines must be marked VERIFIED before these templates are used.
- The sign-off, opt-out line and address are added by the app from docs/01. Do not add them here.
- Every template must pass the same validators as custom emails (a test enforces this).

Variables:
- {{greeting}}: "Hi Jane," when a decision maker's first name is known, otherwise "Hi,".
- {{firm_ref}}: the firm's name when known, otherwise "your firm".
- {{cta_url}}: the CTA link from docs/01.

The app reads the blocks below. In email 1, the lines above `---` are the two subject lines (A/B). Emails 2 to 5 go in the same thread and have no subject.

## Email 1 (day 0): observation plus one question

Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...".

```text clearpath:template email1
subject_a: written security plan
subject_b: question about client data
---
{{greeting}}
I run ClearPath IT, a managed IT and compliance service for financial professionals. The FTC Safeguards Rule applies to many non-bank financial firms, and it requires a written information security program. Does {{firm_ref}} have one written down today?
```

## Email 2 (day 3): one requirement for their firm type

One variant per firm type. The app picks the one matching the dossier's firm_type (or "other").

CPA. Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...", "insurers increasingly ask for a WISP at renewal".

```text clearpath:template email2.cpa
{{greeting}}
Following up on my note about the FTC Safeguards Rule, which applies to many accounting firms. One practical reason it comes up: professional liability insurers increasingly ask for a written information security plan at renewal. The rule also expects a designated Qualified Individual, multi-factor authentication, and encryption. Is a written plan something {{firm_ref}} has on file for the next renewal?
```

Tax preparer. Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...", "IRS Publication 4557 ...".

```text clearpath:template email2.tax_preparer
{{greeting}}
Following up on my last note. IRS Publication 4557 says tax professionals need a written information security plan, and the FTC Safeguards Rule applies to tax preparers directly. The plan names a Qualified Individual, covers how client data is protected, and includes an incident response plan. Is that already written down for {{firm_ref}}?
```

Bookkeeper. Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...".

```text clearpath:template email2.bookkeeper
{{greeting}}
Following up on my note about the FTC Safeguards Rule, which applies to many bookkeeping firms. If your team logs in to client bank or payroll accounts, two of its requirements matter most: access controls and multi-factor authentication. The rule also asks for a written plan that documents both. If a client or CPA partner asked {{firm_ref}} how those logins are protected, is there a written answer to send them?
```

Payroll. Relies on docs/02: "Requires a written information security program ...". Hedged on whether the rule applies, since docs/02 does not name payroll firms.

```text clearpath:template email2.payroll
{{greeting}}
Following up on my note. If {{firm_ref}} falls under the FTC Safeguards Rule, two of its requirements stand out for payroll work: encryption of customer information such as bank details, and oversight of the service providers you rely on. Both belong in a written information security program. If a client asked for that documentation, would it be ready to send?
```

Credit counseling. Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...".

```text clearpath:template email2.credit_counseling
{{greeting}}
Following up on my note. The FTC Safeguards Rule applies to many non-bank financial firms and requires access controls, a written risk assessment, and a written information security program. For a counseling agency, that means documenting who can open client files and how they are protected. If a funder or accreditor asked {{firm_ref}} for that documentation, would it be ready?
```

Collections. Relies on docs/02: "applies to non-bank financial institutions", "Requires a written information security program ...".

```text clearpath:template email2.collections
{{greeting}}
Following up on my note. The FTC Safeguards Rule applies to many non-bank financial firms, and it requires access controls and a written information security program. If a creditor client asked for a written summary of who can access account data and how that access is controlled, could {{firm_ref}} send one today?
```

Other or unknown firm type. Relies on docs/02: "Requires a written information security program ...".

```text clearpath:template email2.other
{{greeting}}
Following up on my note about the FTC Safeguards Rule. Its core requirements are a designated Qualified Individual, a written risk assessment, access controls, encryption, multi-factor authentication, and an incident response plan, all described in a written information security program. Is any of that written down at {{firm_ref}} today?
```

## Email 3 (day 7): offer the 2-minute scorecard

Relies on docs/02: "Requires a written information security program ...". Assumes the 2-minute scorecard exists and can be sent by reply. If it does not exist yet, this email must change before use.

```text clearpath:template email3
{{greeting}}
I put together a 2-minute scorecard that checks the main Safeguards Rule items: a written plan, a Qualified Individual, multi-factor authentication, encryption, and an incident response plan. It shows where {{firm_ref}} stands without a call or a sales pitch. Want me to send it over?
```

## Email 4 (day 12): useful checklist (no founding-client offer is approved)

Relies on docs/02: "Requires a written information security program ...". The only link is the CTA link.

```text clearpath:template email4
{{greeting}}
In case it is useful, here is the short version of what the Safeguards Rule asks for:
1. A designated Qualified Individual
2. A written risk assessment
3. Access controls and multi-factor authentication
4. Encryption of customer information
5. An incident response plan
6. Oversight of service providers
If you want a second set of eyes on any of it, you can book an assessment here: {{cta_url}}
```

## Email 5 (day 18): break-up

```text clearpath:template email5
{{greeting}}
I have not heard back, so I will assume the timing is not right and will not follow up again. If a written security plan comes up later, just reply to this email.
```
