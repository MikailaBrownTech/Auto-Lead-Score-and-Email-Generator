import { z } from "zod";

export const OUTCOMES = [
  "no_reply",
  "reply_positive",
  "reply_neutral",
  "reply_negative",
  "meeting_booked",
  "unsubscribe",
  "bounce",
] as const;

/** One logged result (mirrors LOG_RESULT in PROJECT_INSTRUCTIONS and the docs/07 table). */
export const OutcomeSchema = z
  .object({
    lead_id: z.string().trim().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    persona: z.string().trim().min(1),
    angle: z.string().regex(/^[a-z0-9_]+$/),
    email_number: z.number().int().min(1).max(5),
    outcome: z.enum(OUTCOMES),
    note: z.string().max(500).default(""),
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;
