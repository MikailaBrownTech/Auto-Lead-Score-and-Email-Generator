import { z } from "zod";
import { FIRM_TYPES, FirmTypeSchema } from "./dossier";

/** docs/01 `clearpath:offer` block. Placeholder values are normalized to empty by the loader. */
export const OfferConfigSchema = z
  .object({
    sender_name: z.string().trim().min(1),
    cta_url: z.string().url(),
    opt_out_line: z.string(),
    physical_address: z.string(),
    approved_proof: z.array(z.string()),
    founding_client_offer: z.string().nullable(),
    /** What email 3 offers by reply. The scorecard option must not be used until the scorecard exists. */
    cta_type: z.enum(["checklist", "scorecard"]).default("checklist"),
    /**
     * When true, emails may mention one hedged DNS observation (e.g. a DMARC record set to monitoring
     * only), and only when the domain has MX records. Default false: no DNS remarks.
     */
    include_dns_observation: z.boolean().default(false),
  })
  .strict();
export type OfferConfig = z.infer<typeof OfferConfigSchema>;

const wordLimit = z.number().int().positive();
const keywordList = z.array(z.string().trim().min(1)).min(1);
const angles = z.array(z.string().regex(/^[a-z0-9_]+$/)).min(1);

/** docs/03 `clearpath:style` block. */
export const StyleConfigSchema = z
  .object({
    send_days: z.array(z.number().int().nonnegative()).length(5),
    word_limits: z.object({ "1": wordLimit, "2": wordLimit, "3": wordLimit, "4": wordLimit }).strict(),
    breakup_sentences: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict(),
    subject_max_words: z.number().int().positive(),
    max_links_per_email: z.number().int().nonnegative(),
    max_personal_details_per_email: z.number().int().nonnegative(),
    banned_phrases: z.array(z.string().trim().min(1)).min(1),
    allowed_acronyms: z.array(z.string().regex(/^[A-Z0-9]+$/)),
    proof_patterns: z.array(z.string().trim().min(1)).min(1),
    /**
     * A sentence that pairs a negation with a plan term ("you don't have a WISP") claims the firm lacks
     * a plan. We never know that, so it is blocked. Questions and "if ..." sentences are exempt.
     */
    absence_claims: z
      .object({
        negations: z.array(z.string().trim().min(1)).min(1),
        plan_terms: z.array(z.string().trim().min(1)).min(1),
      })
      .strict(),
    firm_type_angles: z
      .object({
        cpa: angles,
        tax_preparer: angles,
        bookkeeper: angles,
        payroll: angles,
        credit_counseling: angles,
        collections: angles,
        credit_repair: angles,
        other: angles,
      } satisfies Record<(typeof FIRM_TYPES)[number], typeof angles>)
      .strict(),
  })
  .strict()
  .refine((s) => s.send_days.every((d, i) => i === 0 || d > s.send_days[i - 1]!), "send_days must increase")
  .refine((s) => s.breakup_sentences.min <= s.breakup_sentences.max, "breakup_sentences.min must be <= max");
export type StyleConfig = z.infer<typeof StyleConfigSchema>;

/** Criterion keys are fixed in code (scoring functions); labels and points come from docs/06. */
export const SCORING_KEYS = [
  "firm_type_in_target",
  "size_in_range",
  "us_location",
  "target_industry_fit",
  "decision_maker_named",
  "no_wisp_mention",
  "dmarc_missing_or_none",
  "personal_email_domain",
  "sensitive_data_services",
  "doc_exchange_without_portal",
  "public_business_email",
  "site_maintained",
  "phone_or_contact_form",
] as const;
export type ScoringKey = (typeof SCORING_KEYS)[number];

/** docs/06 `clearpath:scoring` block. */
export const ScoringConfigSchema = z
  .object({
    criteria: z.array(
      z
        .object({
          key: z.enum(SCORING_KEYS),
          group: z.enum(["fit", "signals", "reachability"]),
          label: z.string().trim().min(1),
          points: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    tiers: z.object({ A: z.number().int().min(0).max(100), B: z.number().int().min(0).max(100) }).strict(),
    target_firm_types: z.array(FirmTypeSchema).min(1),
    staff_range: z.object({ min: z.number().int().positive(), max: z.number().int().positive() }).strict(),
    site_maintained_months: z.number().int().positive(),
    sensitive_data_keywords: z.array(z.string().trim().min(1)).min(1),
    /** Also matches subdomains, e.g. "rr.com" covers "columbus.rr.com". */
    personal_email_domains: z.array(z.string().trim().toLowerCase().min(3)).min(1),
    /** Keywords the code searches cleaned page text for (docs/06 "no WISP/security mention"). */
    wisp_keywords: z.array(z.string().trim().min(1)).min(1),
    /** A searched page with less cleaned text than this is treated as near-empty and does not count. */
    wisp_search_min_text_chars: z.number().int().positive(),
    /** Without a privacy or security page, the search needs at least this many complete pages. */
    wisp_min_pages: z.number().int().positive(),
    /** Fit points below this cap the tier at C. */
    fit_threshold: z.number().int().nonnegative(),
    /** Staff counts above this make the lead out_of_icp (no sequence without approval). */
    max_staff_for_sequence: z.number().int().positive(),
    /** Reduced points for weaker evidence (each at most its criterion's points). */
    partial_points: z
      .object({
        /** public_business_email when the address is a generic inbox or not tied to a named person. */
        public_business_email_generic: z.number().int().nonnegative(),
        /** decision_maker_named when the person's title is not on the preference list (role_unconfirmed). */
        decision_maker_role_unconfirmed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
  .superRefine((c, ctx) => {
    const total = c.criteria.reduce((s, x) => s + x.points, 0);
    if (total !== 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criteria"], message: `points must sum to 100 (got ${total})` });
    const keys = c.criteria.map((x) => x.key);
    for (const k of SCORING_KEYS) {
      const n = keys.filter((x) => x === k).length;
      if (n !== 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["criteria"], message: `criterion ${k} must appear exactly once (found ${n})` });
    }
    if (c.tiers.A <= c.tiers.B) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers"], message: "tier A cutoff must be above tier B" });
    if (c.staff_range.min > c.staff_range.max) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["staff_range"], message: "staff_range.min must be <= max" });
    const pts = (k: ScoringKey) => c.criteria.find((x) => x.key === k)?.points ?? 0;
    if (c.partial_points.public_business_email_generic > pts("public_business_email")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partial_points"], message: "public_business_email_generic must not exceed the public_business_email points" });
    }
    if (c.partial_points.decision_maker_role_unconfirmed > pts("decision_maker_named")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["partial_points"], message: "decision_maker_role_unconfirmed must not exceed the decision_maker_named points" });
    }
  });
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/**
 * docs/06 `clearpath:evidence` block: editable lists the code uses to check and interpret facts.
 */
export const EvidenceConfigSchema = z
  .object({
    /** A firm_type quote must contain one of its type's keywords. Also used to find secondary types in services. */
    firm_type_keywords: z
      .object({
        cpa: keywordList,
        tax_preparer: keywordList,
        bookkeeper: keywordList,
        payroll: keywordList,
        credit_counseling: keywordList,
        collections: keywordList,
        credit_repair: keywordList,
      } satisfies Record<Exclude<(typeof FIRM_TYPES)[number], "other">, typeof keywordList>)
      .strict(),
    /** An evidence quote containing any of these is rejected and re-selected (family and personal details). */
    personal_terms: keywordList,
    /** Decision maker = the named person whose title matches the earliest entry. */
    decision_maker_title_preferences: keywordList,
    /**
     * Local parts (before the @) of shared role inboxes: info@, office@, contact@. Such an address is
     * never greeted by name and earns partial public-email points.
     */
    generic_inbox_prefixes: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9._-]+$/)).min(1),
  })
  .strict();
export type EvidenceConfig = z.infer<typeof EvidenceConfigSchema>;

/** A docs/02 line carrying the exact VERIFIED marker. Only these may reach the writer. */
export interface RegulatoryFact {
  id: number;
  text: string;
}
