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
 * One email. `body` runs from the greeting to the last sentence before the sign-off;
 * the sign-off (sender name), opt-out line and address are appended by code from docs/01.
 */
export const SequenceEmailSchema = z
  .object({
    n: z.number().int().min(1).max(5),
    send_day: z.number().int().nonnegative(),
    subject_a: z.string().trim().min(1).nullable(),
    subject_b: z.string().trim().min(1).nullable(),
    body: z.string().trim().min(1),
    /** Dossier fields this email relies on. Every listed field must be found (not NOT_FOUND). */
    grounding: z.array(FactFieldSchema),
    /** True when the email came from docs/09 templates rather than the writer model. */
    template: z.boolean(),
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

/** One email as the writer model returns it. The code adds the greeting, sign-off, footer, and send day. */
export const WriterEmailSchema = z
  .object({
    n: z.number().int().min(1).max(5).describe("Email number."),
    subject_a: z.string().trim().min(1).nullable().describe("Email 1 only: subject line A (lowercase). null for emails 2-5."),
    subject_b: z.string().trim().min(1).nullable().describe("Email 1 only: subject line B (lowercase). null for emails 2-5."),
    body: z
      .string()
      .trim()
      .min(1)
      .describe("The email text after the greeting and before the sign-off. No greeting line, no sign-off, no name, no opt-out line."),
    grounding: z
      .array(z.enum(WRITER_GROUNDING))
      .describe("Every prospect fact this email uses. At most one besides firm_name and firm_type."),
  })
  .strict();
export type WriterEmail = z.infer<typeof WriterEmailSchema>;

export const WriterOutputSchema = z
  .object({
    persona: z.string().trim().min(1).max(80).describe("The docs/08 persona heading this sequence is written for."),
    angle: z.string().regex(/^[a-z0-9_]+$/).describe("One angle from allowed_angles."),
    emails: z.array(WriterEmailSchema).min(1).max(5).describe("Exactly the emails listed in emails_to_write, in order."),
  })
  .strict();
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

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

export const WRITER_TOOL_NAME = "write_sequence";
export const JUDGE_TOOL_NAME = "record_judgment";
