# Regulatory facts. Use ONLY lines marked VERIFIED.

Change [VERIFY] to VERIFIED only after you check the primary source (ftc.gov, irs.gov).

- FTC Safeguards Rule (16 CFR Part 314) applies to non-bank financial institutions, including tax preparers and many accounting and bookkeeping firms. VERIFIED
- Requires a written information security program, a designated Qualified Individual, a written risk assessment, access controls, encryption, multi-factor authentication, an incident response plan, and oversight of service providers. VERIFIED
- Requires notifying the FTC after certain security events involving unencrypted customer information, within 30 days of discovery, above a consumer-count threshold. VERIFIED
- IRS Publication 4557 (Safeguarding Taxpayer Data) and the IRS "Security Six" practices. Tax professionals must have a written information security plan (WISP). VERIFIED
- Maximum civil penalty per violation: $50,000. VERIFIED
- Professional liability insurers increasingly ask for a WISP at renewal. VERIFIED

## Approved sentences used by the app

Emails never contain regulatory or insurer statements written by the model. The app inserts these sentences verbatim into fixed slots (email 1: applicability, email 2: one requirement, email 4: the checklist). The validator rejects any other sentence that mentions the FTC, the Safeguards Rule, the IRS, Pub 4557, a WISP, penalties, fines, "required", "must", compliance, or what insurers do, and any "all/every/always/generally covered" outside these sentences.

- source: the opening words of the VERIFIED line above that the sentence restates. A sentence whose line is not VERIFIED, or that mentions money or penalties, is not used.
- emails: which email slots may use it. firm_types: which firm types it fits ("any" for all). The first match wins.

```json clearpath:regulatory
{
  "approved_sentences": [
    {
      "id": "applies_accounting_tax",
      "text": "The FTC Safeguards Rule applies to non-bank financial institutions, including tax preparers and many accounting and bookkeeping firms.",
      "source": "FTC Safeguards Rule (16 CFR Part 314) applies to non-bank financial institutions",
      "emails": [1],
      "firm_types": ["cpa", "tax_preparer", "bookkeeper"]
    },
    {
      "id": "applies_non_bank",
      "text": "The FTC Safeguards Rule applies to non-bank financial institutions.",
      "source": "FTC Safeguards Rule (16 CFR Part 314) applies to non-bank financial institutions",
      "emails": [1],
      "firm_types": ["any"]
    },
    {
      "id": "irs_pub_4557_wisp",
      "text": "IRS Publication 4557 says tax professionals must have a written information security plan.",
      "source": "IRS Publication 4557 (Safeguarding Taxpayer Data)",
      "emails": [2],
      "firm_types": ["tax_preparer"]
    },
    {
      "id": "insurers_ask_at_renewal",
      "text": "Professional liability insurers increasingly ask for a written information security plan at renewal.",
      "source": "Professional liability insurers increasingly ask for a WISP at renewal",
      "emails": [2],
      "firm_types": ["cpa"]
    },
    {
      "id": "rule_requirements",
      "text": "The rule requires a written information security program, a designated Qualified Individual, a written risk assessment, access controls, encryption, multi-factor authentication, and an incident response plan.",
      "source": "Requires a written information security program",
      "emails": [2, 4],
      "firm_types": ["any"]
    }
  ]
}
```
