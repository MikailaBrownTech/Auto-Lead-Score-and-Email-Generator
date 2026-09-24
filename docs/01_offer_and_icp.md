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
- sender_title, company_name, company_website: signature lines added by the app under sender_name on every email. The company name comes only from here; the writer never writes one. Export is blocked while any is empty.
- checklist_ready: true once the one-page checklist exists and can be sent by reply. While false, a sequence that includes email 3 is blocked from export.
- allow_without_direct_contact: global override for leads without a person-tied public address (a generic inbox such as info@, an address not tied to a named person, or no address at all). While false, those leads are needs_direct_contact: approval and export are blocked until a person-tied address is provided (paste mode) or the lead is overridden individually with a logged reason.
- include_dns_observation: true lets an email mention one DNS observation (for example a DMARC record set to monitoring only), hedged, and only when the domain has email (MX records). Default false: no DNS remarks in emails.

```json clearpath:offer
{
  "sender_name": "Mikaila Brown",
  "sender_title": "Founder",
  "company_name": "ClearPath IT",
  "company_website": "https://www.clearpathsecure.com",
  "cta_url": "https://www.clearpathsecure.com/contact",
  "opt_out_line": "",
  "physical_address": "",
  "approved_proof": [],
  "founding_client_offer": null,
  "cta_type": "checklist",
  "include_dns_observation": false,
  "checklist_ready": false,
  "allow_without_direct_contact": false
}
```
