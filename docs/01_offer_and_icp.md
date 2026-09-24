# ClearPath IT: Offer and ICP

COMPANY: ClearPath IT, flat-rate managed IT and compliance for financial professionals. Founder: Mikaila Brown, has a Bachelors of Science in Information Technology and holds several industry security certifications.

TARGETS: CPA firms 5-20 staff, tax preparers 1-10, bookkeepers, payroll firms 5-25, credit counselors 3-15, collection agencies 5-30. Start with Ohio and neighboring states.

SERVICES: WISP documentation, endpoint security and encryption, Microsoft 365 hardening, access control, breach response support, backup and recovery.

PRICING: do not quote pricing

CTAS: Assessment booking link (cta_url below). Use one per email.

COMMON OBJECTIONS: [we already have an IT guy / we're too small / we're not a financial institution / too busy in tax season] -> [your true, brief responses]

## Settings used by the app

The app reads and writes only the block below (Settings screen). Leave a value empty ("", [] or null) until it is true and final; any value still in [brackets] is treated as empty.

- opt_out_line: e.g. "If this isn't relevant, reply 'no' and I won't email again." Export is blocked while empty.
- physical_address: your business mailing address. Export is blocked while empty.
- approved_proof: only real pilot clients, real credentials, real results. While empty, emails make no proof claims.
- founding_client_offer: approved wording, or null for none. While null, email 4 uses the checklist.
- cta_type: what email 3 offers by reply: "checklist" (a one-page Safeguards Rule checklist) or "scorecard" (the 2-minute scorecard). Use "scorecard" only once the scorecard exists.

```json clearpath:offer
{
  "sender_name": "Mikaila Brown",
  "cta_url": "https://www.clearpathsecure.com/contact",
  "opt_out_line": "",
  "physical_address": "",
  "approved_proof": [],
  "founding_client_offer": null,
  "cta_type": "checklist"
}
```
