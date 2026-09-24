import { z } from "zod";
import { evidenced, isFound, NOT_FOUND } from "./evidence";

export const FIRM_TYPES = [
  "cpa",
  "tax_preparer",
  "bookkeeper",
  "payroll",
  "credit_counseling",
  "collections",
  "other",
] as const;
export const FirmTypeSchema = z.enum(FIRM_TYPES);
export type FirmType = z.infer<typeof FirmTypeSchema>;

/** YYYY-MM or YYYY-MM-DD. */
export const PartialDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/, "date must be YYYY-MM or YYYY-MM-DD");

const nonEmpty = z.string().trim().min(1);

/**
 * Fields the extraction model fills from page text (docs/04). Each is evidenced or NOT_FOUND.
 * Descriptions become part of the tool-use JSON schema the model sees.
 */
export const ExtractedFactsSchema = z
  .object({
    firm_name: evidenced(nonEmpty).describe("Legal or trading name of the firm."),
    firm_type: evidenced(FirmTypeSchema).describe("Primary business type."),
    location: evidenced(
      z
        .object({ city: nonEmpty.nullable(), state: nonEmpty.nullable(), country: nonEmpty.nullable() })
        .strict(),
    ).describe("Where the firm is located."),
    in_scope: evidenced(z.boolean()).describe("True only if a US business in a target industry."),
    size_signal: evidenced(
      z.object({ staff_count: z.number().int().positive().nullable(), text: nonEmpty }).strict(),
    ).describe("Staff size, only if stated or countable on a team page."),
    services: evidenced(z.array(nonEmpty).min(1)).describe("Services the firm offers."),
    software_mentioned: evidenced(z.array(nonEmpty).min(1)).describe("Software or platforms named on the site."),
    client_portal_or_doc_exchange: evidenced(
      z.object({ doc_exchange: z.boolean(), secure_portal: z.boolean() }).strict(),
    ).describe("Whether the site mentions exchanging documents, and whether it mentions a secure portal."),
    decision_maker: evidenced(z.object({ name: nonEmpty, title: nonEmpty.nullable() }).strict()).describe(
      "Owner, partner, or principal named on the site.",
    ),
    public_contact_email: evidenced(z.string().email()).describe("Business email address shown on the site."),
    personal_email_domain_on_site: evidenced(z.string().email()).describe(
      "An address at a personal email provider (gmail, yahoo, aol, etc.) used as a firm address.",
    ),
    privacy_policy_present: evidenced(z.boolean()).describe("Whether the site has a privacy policy."),
    security_or_wisp_mention: evidenced(nonEmpty).describe("Text mentioning a WISP, security program, or safeguards."),
    recent_signal: evidenced(z.object({ text: nonEmpty, date: PartialDateSchema }).strict()).describe(
      "A dated recent event: new hire, new service, or news.",
    ),
    phone_or_contact_form: evidenced(
      z.object({ phone: nonEmpty.nullable(), contact_form: z.boolean() }).strict(),
    ).describe("A phone number shown on the site, or a contact form."),
    latest_dated_content: evidenced(z.object({ text: nonEmpty, date: PartialDateSchema }).strict()).describe(
      "The most recent dated item on the site (a copyright year does not count).",
    ),
  })
  .strict();
export type ExtractedFacts = z.infer<typeof ExtractedFactsSchema>;

export const FACT_FIELDS = Object.keys(ExtractedFactsSchema.shape) as (keyof ExtractedFacts)[];
export type FactField = keyof ExtractedFacts;

export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;

export const DnsFindingsSchema = z
  .object({
    mx_provider: evidenced(nonEmpty),
    spf_present: evidenced(z.boolean()),
    dmarc_present: evidenced(z.boolean()),
    dmarc_policy: evidenced(z.enum(DMARC_POLICIES)),
    dkim: z.literal("NOT_CHECKED"),
  })
  .strict();
export type DnsFindings = z.infer<typeof DnsFindingsSchema>;

export const DNS_FIELDS = ["mx_provider", "spf_present", "dmarc_present", "dmarc_policy"] as const;
export const DNS_EVIDENCE_RE = /^dns:(MX|TXT) \S+$/;

export const PAGE_KINDS = ["home", "about", "team", "services", "contact", "privacy", "security", "other"] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKindSchema>;

/**
 * Filled by code, never by the LLM: a deterministic keyword search of the cleaned page text for any
 * security/WISP mention. It is the evidence for the "no WISP/security mention" score (docs/06).
 */
export const SecurityMentionSearchSchema = z.union([
  z.literal("NOT_CHECKED"),
  z
    .object({
      keywords: z.array(nonEmpty).min(1),
      pages: z.array(
        z
          .object({
            url: z.string().url(),
            kind: PageKindSchema,
            http_status: z.number().int(),
            content_type: z.string(),
            truncated: z.boolean(),
            text_chars: z.number().int().nonnegative(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
          })
          .strict(),
      ),
      matches: z.array(z.object({ url: z.string().url(), keyword: nonEmpty }).strict()),
    })
    .strict(),
]);
export type SecurityMentionSearch = z.infer<typeof SecurityMentionSearchSchema>;

export const DossierSchema = z
  .object({
    lead_id: nonEmpty,
    source: z.enum(["web", "pasted"]),
    url: z.string(),
    domain: z.string(),
    pages_opened: z.array(z.string().url()),
    failures: z.array(z.string()),
    prompt_injection_flag: z.boolean(),
    ...ExtractedFactsSchema.shape,
    dns: DnsFindingsSchema,
    security_mention_search: SecurityMentionSearchSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    const pages = new Set(d.pages_opened);
    for (const field of FACT_FIELDS) {
      const f = d[field];
      if (!isFound(f)) continue;
      const ok = d.source === "pasted" ? f.evidence_url === "pasted" : pages.has(f.evidence_url);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field, "evidence_url"],
          message:
            d.source === "pasted"
              ? `evidence_url must be "pasted" for a pasted-text dossier`
              : `evidence_url ${f.evidence_url} is not one of the pages opened`,
        });
      }
    }
    if (d.security_mention_search !== "NOT_CHECKED") {
      d.security_mention_search.pages.forEach((p, i) => {
        if (!pages.has(p.url)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["security_mention_search", "pages", i, "url"],
            message: `searched page ${p.url} is not one of the pages opened`,
          });
        }
      });
    }
    for (const field of DNS_FIELDS) {
      const f = d.dns[field];
      if (f !== NOT_FOUND && !DNS_EVIDENCE_RE.test(f.evidence_url)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["dns", field, "evidence_url"],
          message: `DNS evidence must look like "dns:TXT _dmarc.example.com"`,
        });
      }
    }
  });
export type Dossier = z.infer<typeof DossierSchema>;
