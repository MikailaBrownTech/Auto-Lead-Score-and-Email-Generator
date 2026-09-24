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
  })
  .strict();
export type OfferConfig = z.infer<typeof OfferConfigSchema>;

const wordLimit = z.number().int().positive();
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
    firm_type_angles: z
      .object({
        cpa: angles,
        tax_preparer: angles,
        bookkeeper: angles,
        payroll: angles,
        credit_counseling: angles,
        collections: angles,
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
  "us_in_scope",
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
    personal_email_domains: z.array(z.string().trim().toLowerCase().min(3)).min(1),
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
  });
export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/** A docs/02 line carrying the exact VERIFIED marker. Only these may reach the writer. */
export interface RegulatoryFact {
  id: number;
  text: string;
}
