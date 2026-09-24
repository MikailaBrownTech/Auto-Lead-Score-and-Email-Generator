import { z } from "zod";
import { EvidenceQuoteSchema, EvidenceUrlSchema, evidenced, foundList, isFound, NOT_FOUND } from "./evidence";

export const FIRM_TYPES = [
  "cpa",
  "tax_preparer",
  "bookkeeper",
  "payroll",
  "credit_counseling",
  "collections",
  "credit_repair",
  "other",
] as const;
export const FirmTypeSchema = z.enum(FIRM_TYPES);
export type FirmType = z.infer<typeof FirmTypeSchema>;

/** YYYY-MM or YYYY-MM-DD. */
export const PartialDateSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/, "date must be YYYY-MM or YYYY-MM-DD");

const nonEmpty = z.string().trim().min(1);

export const EXCLUSION_SIGNALS = [
  "government_or_nonprofit_only",
  "non_us",
  "individual_practitioner",
  "not_a_firm",
  "closed_or_acquired",
  "other",
] as const;

/** A person named on the site, with the quote that names them. The code picks the decision maker. */
export const PersonSchema = z
  .object({
    name: nonEmpty,
    title: nonEmpty.nullable(),
    evidence_url: EvidenceUrlSchema,
    evidence_quote: EvidenceQuoteSchema,
  })
  .strict();
export type Person = z.infer<typeof PersonSchema>;

export const ExclusionSignalSchema = z
  .object({
    signal: z.enum(EXCLUSION_SIGNALS),
    evidence_url: EvidenceUrlSchema,
    evidence_quote: EvidenceQuoteSchema,
  })
  .strict();
export type ExclusionSignal = z.infer<typeof ExclusionSignalSchema>;

/** services/software: the code keeps at most this many items found on the pages (extra items are dropped, never rejected). */
export const MAX_LIST_ITEMS = 25;

/** A plain list the model reads off the pages; the code then finds each item in a page's text. */
const modelList = (what: string) =>
  z
    .union([z.literal(NOT_FOUND), z.array(nonEmpty).min(1).max(MAX_LIST_ITEMS)])
    .describe(`${what} Copy each item exactly as a page writes it (the code searches the page text for it). No quotes needed.`);

/**
 * Fields the extraction model fills from page text (docs/04), as the model returns them. Each is
 * evidenced or NOT_FOUND (people and exclusion_signals are lists; an empty list means none found).
 * services and software_mentioned are plain lists; the code verifies each item against the page text.
 * Descriptions become part of the tool-use JSON schema the model sees.
 */
export const ModelFactsSchema = z
  .object({
    firm_name: evidenced(nonEmpty).describe(
      "The firm's name. The quote must contain the name; it may be copied from a page's title attribute.",
    ),
    firm_type: evidenced(
      z.object({ primary: FirmTypeSchema, secondary: z.array(FirmTypeSchema).max(3) }).strict(),
    ).describe("Primary business type, plus any secondary types the firm also offers. The quote must name the primary type."),
    location: evidenced(
      z
        .object({ city: nonEmpty.nullable(), state: nonEmpty.nullable(), country: nonEmpty.nullable() })
        .strict(),
    ).describe("Where the firm is located. The quote must contain the city when a city is given."),
    size_signal: evidenced(
      z.object({ staff_count: z.number().int().positive().nullable(), text: nonEmpty }).strict(),
    ).describe(
      "How many people WORK at the firm (staff, team members, employees), only if stated or countable on a team page. The quote must contain the number. Never clients, companies, or returns served.",
    ),
    client_count_signal: evidenced(
      z.object({ count: z.number().int().positive().nullable(), text: nonEmpty }).strict(),
    ).describe("How many clients, companies, or returns the firm says it serves. Recorded only; never used as staff size."),
    services: modelList("Services the firm offers."),
    software_mentioned: modelList("Software or platforms named on the site."),
    client_portal_or_doc_exchange: evidenced(
      z.object({ doc_exchange: z.literal(true).nullable(), secure_portal: z.literal(true).nullable() }).strict(),
    ).describe(
      "doc_exchange: true if the quote mentions clients sending or exchanging documents. secure_portal: true if it mentions a secure or client portal. Use null for anything the quote does not show; never false.",
    ),
    people: z
      .array(PersonSchema)
      .max(5)
      .describe("Up to 5 owners, partners, principals, or managers named on the site, each with a quote containing the name."),
    public_contact_email: evidenced(
      z.object({ address: z.string().email(), owner_name: nonEmpty.nullable() }).strict(),
    ).describe("Business email address shown on the site. owner_name is the person the same quote ties it to, or null."),
    personal_email_domain_on_site: evidenced(z.string().email()).describe(
      "An address at a personal email provider (gmail, yahoo, aol, etc.) used as a firm address.",
    ),
    privacy_policy_present: evidenced(z.literal(true)).describe("true, with a quote, when the site shows a privacy policy. Otherwise NOT_FOUND; never false."),
    security_or_wisp_mention: evidenced(nonEmpty).describe(
      "The firm describing its OWN security practices for its clients' information (a WISP, security program, encryption of client files, safeguards). IT, audit, or assurance services the firm sells to clients do not count.",
    ),
    phone_or_contact_form: evidenced(
      z.object({ phone: nonEmpty.nullable(), contact_form: z.literal(true).nullable() }).strict(),
    ).describe("A phone number shown on the site (the quote must contain it), or contact_form true when the quote shows a contact form. null when not shown; never false."),
    exclusion_signals: z
      .array(ExclusionSignalSchema)
      .max(5)
      .describe("Reasons this firm may be outside the target market, each with a quote. Empty list if none."),
  })
  .strict();
export type ModelFacts = z.infer<typeof ModelFactsSchema>;

/**
 * Verified facts as stored in the dossier. Same as the model's fields, except services and
 * software_mentioned keep only items the code found in a fetched page's text, with that page's URL.
 */
export const ExtractedFactsSchema = ModelFactsSchema.extend({
  /** source "code": the model's firm_type did not verify and the code derived it from docs/06 keywords. */
  firm_type: evidenced(
    z.object({ primary: FirmTypeSchema, secondary: z.array(FirmTypeSchema).max(3), source: z.enum(["model", "code"]).optional() }).strict(),
  ),
  services: foundList(nonEmpty),
  software_mentioned: foundList(nonEmpty),
});
export type ExtractedFacts = z.infer<typeof ExtractedFactsSchema>;

export const FACT_FIELDS = Object.keys(ExtractedFactsSchema.shape) as (keyof ExtractedFacts)[];
export type FactField = keyof ExtractedFacts;
/** Fields whose value is a list of items, each with its own evidence. */
export const LIST_FIELDS = ["people", "exclusion_signals"] as const satisfies readonly FactField[];
/** Plain lists verified by searching page text (no per-item quote). */
export const FOUND_LIST_FIELDS = ["services", "software_mentioned"] as const satisfies readonly FactField[];

/** How the public address relates to the people on the site (code-derived). */
export const PUBLIC_EMAIL_KINDS = ["named_person", "generic_inbox", "unattributed"] as const;
export type PublicEmailKind = (typeof PUBLIC_EMAIL_KINDS)[number];

/** Where a firm-name candidate came from in the homepage markup. */
export const NAME_HINT_SOURCES = ["jsonld_organization", "og_site_name", "title"] as const;
export const NameHintSchema = z.object({ source: z.enum(NAME_HINT_SOURCES), value: nonEmpty }).strict();
export type NameHint = z.infer<typeof NameHintSchema>;

export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;

export const DnsFindingsSchema = z
  .object({
    mx_provider: evidenced(nonEmpty),
    /** true when the domain definitively has no MX records (NXDOMAIN/NODATA); SPF/DMARC then score nothing. */
    no_domain_email: evidenced(z.boolean()),
    spf_present: evidenced(z.boolean()),
    dmarc_present: evidenced(z.boolean()),
    dmarc_policy: evidenced(z.enum(DMARC_POLICIES)),
    dkim: z.literal("NOT_CHECKED"),
  })
  .strict();
export type DnsFindings = z.infer<typeof DnsFindingsSchema>;

export const DNS_FIELDS = ["mx_provider", "no_domain_email", "spf_present", "dmarc_present", "dmarc_policy"] as const;
export const DNS_EVIDENCE_RE = /^dns:(MX|TXT) \S+$/;

export const PAGE_KINDS = ["home", "about", "team", "services", "contact", "privacy", "security", "news", "other"] as const;
export const PageKindSchema = z.enum(PAGE_KINDS);
export type PageKind = z.infer<typeof PageKindSchema>;

/**
 * Filled by code, never by the LLM: a deterministic keyword search of the full cleaned page text
 * (not the token-capped copy) for any security/WISP mention. Evidence for "no WISP/security mention".
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

/**
 * Suspected prompt injection. "visible"/"hidden" come from the code's pattern scan of page text
 * (hidden = display:none, aria-hidden, HTML comments); "model" means the extraction model flagged it.
 */
export const InjectionFindingSchema = z
  .object({
    url: z.string().min(1),
    where: z.enum(["visible", "hidden", "model"]),
    snippet: z.string().max(300),
  })
  .strict();
export type InjectionFinding = z.infer<typeof InjectionFindingSchema>;

export const FRESHNESS_SOURCES = [
  "time_element",
  "article_published_time",
  "jsonld_date_published",
  "jsonld_date_modified",
  "sitemap_lastmod",
  /** A /YYYY/MM/DD/ date in a page or sitemap URL path. Lower confidence: used only when no markup or sitemap date exists. */
  "url_date",
] as const;
export const FreshnessSourceSchema = z.enum(FRESHNESS_SOURCES);

/**
 * Filled by code from machine-readable dates only (<time datetime>, article:published_time, JSON-LD
 * datePublished/dateModified, sitemap lastmod). Copyright years, "founded" dates, and policy pages
 * never count. evidence_url is the page or sitemap the date came from.
 */
export const FreshnessSchema = evidenced(z.object({ date: PartialDateSchema, source: FreshnessSourceSchema }).strict());

export const EmailSecurityHintSchema = z
  .object({
    rua_domains: z.array(nonEmpty),
    ruf_domains: z.array(nonEmpty),
    /** Report domains that are not the firm's own and not on config/dmarc-vendors.json. */
    outside_domains: z.array(nonEmpty),
    evidence_url: z.string().regex(/^dns:TXT \S+$/),
    note: nonEmpty,
  })
  .strict();
export type EmailSecurityHint = z.infer<typeof EmailSecurityHintSchema>;

/** Computed by code from verified facts and docs/06 lists. */
export const FitSchema = z
  .object({ value: z.boolean().nullable(), reason: nonEmpty, qualifying_type: FirmTypeSchema.nullable().default(null) })
  .strict();

export const GATE_STATUSES = ["qualified", "out_of_icp", "needs_review"] as const;
export const GateSchema = z.object({ status: z.enum(GATE_STATUSES), reasons: z.array(nonEmpty) }).strict();
export type Gate = z.infer<typeof GateSchema>;

export const DossierSchema = z
  .object({
    lead_id: nonEmpty,
    source: z.enum(["web", "pasted"]),
    url: z.string(),
    domain: z.string(),
    pages_opened: z.array(z.string().url()),
    failures: z.array(z.string()),
    prompt_injection_flag: z.boolean(),
    injection_findings: z.array(InjectionFindingSchema).default([]),
    /** The site answered HTTP 403/429; no further requests were made. The UI asks for pasted text. */
    declined_automated_access: z.boolean().default(false),
    /** Firm-name candidates from the homepage markup, shown to the model to confirm (code-derived). */
    firm_name_candidates: z.array(NameHintSchema).default([]),
    ...ExtractedFactsSchema.shape,
    /**
     * Chosen by code from `people` using the docs/06 title preference list. role_confirmed is false
     * when the person's title is not on that list (scored as role_unconfirmed).
     */
    decision_maker: evidenced(z.object({ name: nonEmpty, title: nonEmpty.nullable(), role_confirmed: z.boolean() }).strict()),
    /** Code-derived from public_contact_email, people, and the docs/06 generic_inbox_prefixes list. */
    public_email_kind: z.union([z.literal(NOT_FOUND), z.enum(PUBLIC_EMAIL_KINDS)]).default(NOT_FOUND),
    /**
     * INTERNAL ONLY (never in writer input or emails): DMARC report addresses (rua/ruf) pointing to an
     * outside domain that is neither the firm's own nor a known DMARC vendor: a possible existing IT provider.
     */
    email_security_hint: z.union([z.literal(NOT_FOUND), EmailSecurityHintSchema]).default(NOT_FOUND),
    /** Code keyword search for portal mentions (docs/06 portal_keywords); evidence for "no portal mentioned". */
    portal_mention_search: SecurityMentionSearchSchema.default("NOT_CHECKED"),
    latest_dated_content: FreshnessSchema,
    us_location: FitSchema,
    target_industry_fit: FitSchema,
    gate: GateSchema,
    dns: DnsFindingsSchema,
    security_mention_search: SecurityMentionSearchSchema,
  })
  .strict()
  .superRefine((d, ctx) => {
    const pages = new Set(d.pages_opened);
    const check = (url: string, path: (string | number)[]) => {
      const ok = d.source === "pasted" ? url === "pasted" : pages.has(url);
      if (!ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            d.source === "pasted"
              ? `evidence_url must be "pasted" for a pasted-text dossier`
              : `evidence_url ${url} is not one of the pages opened`,
        });
      }
    };
    for (const field of FACT_FIELDS) {
      const f = d[field] as unknown;
      if (f === NOT_FOUND) continue;
      if (Array.isArray(f)) {
        f.forEach((item: { evidence_url: string }, i) => check(item.evidence_url, [field, i, "evidence_url"]));
      } else if (typeof f === "object" && f !== null && "evidence" in f) {
        (f as { evidence: { evidence_url: string }[] }).evidence.forEach((e, i) => check(e.evidence_url, [field, "evidence", i, "evidence_url"]));
      } else if (typeof f === "object" && f !== null && "evidence_url" in f) {
        check((f as { evidence_url: string }).evidence_url, [field, "evidence_url"]);
      }
    }
    if (isFound(d.decision_maker)) check(d.decision_maker.evidence_url, ["decision_maker", "evidence_url"]);
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

/**
 * What the writer may see: values only. Evidence quotes (which can contain personal or incidental
 * text) never reach the writer model.
 */
export function writerView(d: Dossier): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (v === NOT_FOUND) return NOT_FOUND;
    if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x && "evidence_quote" in x ? omitEvidence(x) : x));
    if (typeof v === "object" && v !== null && "value" in v) return (v as { value: unknown }).value;
    return v;
  };
  const omitEvidence = (x: object) =>
    Object.fromEntries(Object.entries(x).filter(([k]) => k !== "evidence_quote" && k !== "evidence_url"));
  const out: Record<string, unknown> = {};
  for (const field of FACT_FIELDS) out[field] = strip(d[field]);
  out.decision_maker = strip(d.decision_maker);
  out.latest_dated_content = strip(d.latest_dated_content);
  out.us_location = d.us_location.value;
  out.target_industry_fit = d.target_industry_fit.value;
  out.dns = Object.fromEntries(Object.entries(d.dns).map(([k, v]) => [k, strip(v)]));
  return out;
}
