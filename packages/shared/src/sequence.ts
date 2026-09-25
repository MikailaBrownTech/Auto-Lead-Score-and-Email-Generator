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
 * One email. `body` runs from the greeting or opening line to the last sentence before the signature.
 * Every tier: written by the writer model, with the approved docs/02 sentence spliced in by code.
 * (Older sequences, from before this, may carry `template: true`: the docs/09 fixed copy, whose settings
 * merge fields ({{company}}, {{offer}}, {{booking_link}}, {{region}}, {{company_one_liner}}) are filled
 * from docs/01 when shown, checked, or exported.) The signature block is appended by code either way.
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
    /** True for the old docs/09 fixed copy (legacy sequences only); false when the writer model wrote it. */
    template: z.boolean(),
    /** Legacy: sequences built by the template-first version (2026-09-24) carry their personal line. */
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
 * One email as the writer model returns it: the full body (greeting through the last sentence, no
 * signature). In email 2 the marker [[APPROVED]] stands where the code inserts the approved docs/02
 * sentence.
 */
export const WriterEmailSchema = z
  .object({
    n: z.number().int().min(1).max(5).describe("Email number, 1 to 5."),
    subject_a: z.string().trim().min(1).nullable().describe("Email 1: subject A. Email 4: optional subject. Otherwise null."),
    subject_b: z.string().trim().min(1).nullable().describe("Email 1 only: subject B. Otherwise null."),
    body: z.string().trim().min(1).describe("The full email body, greeting (email 1 only) through the last sentence. No sign-off, name, or footer."),
  })
  .strict();
export type WriterEmail = z.infer<typeof WriterEmailSchema>;

export const WriterOutputSchema = z
  .object({ emails: z.array(WriterEmailSchema).length(5).describe("Emails 1 to 5, in order.") })
  .strict();
export type WriterOutput = z.infer<typeof WriterOutputSchema>;

/** Where the code inserts the approved docs/02 sentence in the writer's draft. */
export const APPROVED_MARKER = "[[APPROVED]]";

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
