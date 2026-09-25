# ClearPath IT: Offer and ICP

COMPANY: ClearPath IT, flat-rate managed IT and compliance for financial professionals. Founder: Mikaila Brown, has a Bachelors of Science in Information Technology and holds several industry security certifications.

TARGETS: CPA firms 5-20 staff, tax preparers 1-10, bookkeepers, payroll firms 5-25, credit counselors 3-15, collection agencies 5-30. Start with Ohio and neighboring states.

SERVICES: WISP documentation, endpoint security and encryption, Microsoft 365 hardening, access control, breach response support, backup and recovery.

PRICING: do not quote pricing

CTAS: the booking link (booking_link below), in email 4 only.

COMMON OBJECTIONS: [we already have an IT guy / we're too small / we're not a financial institution / too busy in tax season] -> [your true, brief responses]

## Settings used by the app

The app reads and writes only the block below (Settings screen). Leave a value empty ("", [] or null) until it is true and final; any value still in [brackets] is treated as empty.

- opt_out_line: e.g. "If this isn't relevant, reply 'no' and I won't email again." Export is blocked while empty.
- physical_address: your business mailing address. Export is blocked while empty.
- approved_proof: only real pilot clients, real credentials, real results. While empty, emails make no proof claims.
- founding_client_offer: the founding-client offer email 4 describes (given to the writer; {{offer}} in the Tier C copy, docs/09). Export is blocked while empty (null).
- booking_link: your calendar link, used in email 4 (given to the writer; {{booking_link}} in docs/09). The only link an email body may contain. Export is blocked while empty.
- region: your target region as it reads in a sentence, e.g. "Cleveland-area" (given to the writer; {{region}} in docs/09). Export is blocked while empty.
- company_one_liner: one sentence about what the company does, given to the writer as a description (never quoted as proof), and {{company_one_liner}} if the docs/09 copy uses it. Optional.
- sender_title, company_name, company_website: the signature block (docs/09 "Signature block") under sender_name on every email. The company name comes only from here. Export is blocked while any is empty.
- checklist_ready: true once the one-page checklist exists and can be sent by reply. While false, a sequence that includes email 3 is blocked from export.
- include_dns_observation: true lets an email mention one DNS observation (for example a DMARC record set to monitoring only), hedged, and only when the domain has email (MX records). Default false: no DNS remarks in emails. The docs/09 templates have no DNS slot, so emails carry none unless you add one by hand.

Greeting (docs/03, docs/09): with no named contact tied to the public address, email 1 opens with a role-based line (never "Hi there,"); with a named contact, "Hi {{first_name}},". Emails 2 to 5 have no greeting. A lead without a named contact is never blocked.

```json clearpath:offer
{
  "sender_name": "Mikaila Brown",
  "sender_title": "Founder",
  "company_name": "Clear Path Secure",
  "company_website": "https://www.clearpathsecure.com",
  "opt_out_line": "Click here to opt out",
  "physical_address": "Cleveland, Ohio",
  "approved_proof": [],
  "founding_client_offer": "Get free security audit",
  "booking_link": "https://www.clearpathsecure.com/contact",
  "region": "Ohio",
  "company_one_liner": "",
  "include_dns_observation": false,
  "checklist_ready": true
}
```
