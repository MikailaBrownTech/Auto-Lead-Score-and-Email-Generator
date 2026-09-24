import { z } from "zod";
import { FACT_FIELDS } from "./dossier";

export const TIERS = ["A", "B", "C"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

/** Dossier fields an email may be grounded on: model facts plus the code-chosen decision maker and freshness date. */
export const GROUNDING_FIELDS = [...FACT_FIELDS, "decision_maker", "latest_dated_content", "dns_observation"] as const;
export type GroundingField = (typeof GROUNDING_FIELDS)[number];
export const FactFieldSchema = z.enum(GROUNDING_FIELDS as unknown as [string, ...string[]]);

/**
 * One email, assembled by code from docs/09_sequences.md. `body` runs from the opening line to the
 * last sentence before the signature. Lead merge fields are filled in; settings merge fields
 * ({{company}}, {{offer}}, {{booking_link}}, {{region}}, {{company_one_liner}}) stay as placeholders and
 * are filled from docs/01 when the email is shown, checked, or exported. The signature block is
 * appended by code.
 */
export const SequenceEmailSchema = z
  .object({
    n: z.number().int().min(1).max(5),
    send_day: z.number().int().nonnegative(),
    /** Email 1: subject A. Emails 3-5: the subject used if the email starts a new thread (docs/09). */
    subject_a: z.string().trim().min(1).nullable(),
    /** Email 1 only: subject B. */
    subject_b: z.string().trim().min(1).nullable(),
    body: z.string().trim().min(1),
    /** Dossier fields this email relies on (found by code in the personal line). Every listed field must be found. */
    grounding: z.array(FactFieldSchema),
    /** True for docs/09 template copy (every email is now). */
    template: z.boolean(),
    /** Email 1: the {{personal_line}} inserted by code, and whether the model or the docs/09 fallback wrote it. */
    personal_line: z.object({ text: z.string().trim().min(1), source: z.enum(["model", "fallback"]) }).strict().optional(),
    /** True once the founder edited the text by hand. Edited emails get the same checks as model-written text (allowlist, judge). */
    edited: z.boolean().optional(),
  })
  .strict();
export type SequenceEmail = z.infer<typeof SequenceEmailSchema>;

export const SequenceSchema = z
  .object({
    lead_id: z.string().trim().min(1),
    tier: TierSchema,
    persona: z.string().trim().min(1),
    angle: z.string().regex(/^[a-z0-9_]+$/),
    emails: z.array(SequenceEmailSchema).length(5),
  })
  .strict()
  .refine((s) => s.emails.every((e, i) => e.n === i + 1), "emails must be numbered 1-5 in order")
  .refine(
    (s) => s.emails[0]?.subject_a != null && s.emails[0]?.subject_b != null,
    "email 1 needs two subject lines (A/B)",
  );
export type Sequence = z.infer<typeof SequenceSchema>;

/**
 * Grounding values the writer may cite: dossier fields shown to it, plus "dns_observation" (a
 * code-worded DNS finding, present only when the include_dns_observation setting is on).
 */
export const WRITER_GROUNDING = [
  "firm_name",
  "firm_type",
  "location",
  "size_signal",
  "services",
  "software_mentioned",
  "client_portal_or_doc_exchange",
  "dns_observation",
] as const;
export type WriterGrounding = (typeof WRITER_GROUNDING)[number];

/**
 * The only thing the model writes: {{personal_line}} in email 1, plus an optional pick of subject A or
 * B. Everything else is docs/09 copy assembled by code.
 */
export const PersonalLineOutputSchema = z
  .object({
    personal_line: z
      .string()
      .trim()
      .min(1)
      .describe("One sentence, at most 30 words, using one or two of the given values. No question, no greeting."),
    subject: z.enum(["A", "B"]).optional().describe("Which of the two subject lines fits this firm better."),
  })
  .strict();
export type PersonalLineOutput = z.infer<typeof PersonalLineOutputSchema>;

export const JUDGE_REASONS = [
  "not_in_prospect_facts",
  "not_in_verified_regulatory_facts",
  "proof_or_credential_claim",
  "claims_firm_lacks_plan",
  "dns_overclaim",
  "personal_detail",
  "guarantee_or_fear",
  "other",
] as const;

/** The judge's verdict: a list of unsupported claims. No reasoning fields. */
export const JudgeOutputSchema = z
  .object({
    unsupported_claims: z
      .array(
        z
          .object({
            email: z.number().int().min(1).max(5),
            claim: z.string().trim().min(1).max(200).describe("The claim, quoted briefly from the email."),
            reason: z.enum(JUDGE_REASONS),
          })
          .strict(),
      )
      .max(20)
      .describe("Every claim not supported by the prospect facts, the verified regulatory facts, or the offer. Empty if none."),
  })
  .strict();
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export const PERSONAL_LINE_TOOL_NAME = "record_personal_line";
export const JUDGE_TOOL_NAME = "record_judgment";
