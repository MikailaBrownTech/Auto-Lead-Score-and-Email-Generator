import { z } from "zod";
import { FACT_FIELDS } from "./dossier";

export const TIERS = ["A", "B", "C"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const FactFieldSchema = z.enum(FACT_FIELDS as [string, ...string[]]);

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
