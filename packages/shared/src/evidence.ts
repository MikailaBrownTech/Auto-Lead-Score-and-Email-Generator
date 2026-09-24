import { z } from "zod";
import { countWords } from "./text";

export const NOT_FOUND = "NOT_FOUND" as const;
export const MAX_QUOTE_WORDS = 15;

export const EvidenceQuoteSchema = z
  .string()
  .trim()
  .min(1, "evidence_quote is empty")
  .refine((q) => countWords(q) <= MAX_QUOTE_WORDS, `evidence_quote must be ${MAX_QUOTE_WORDS} words or fewer`);

/** evidence_url: a fetched page URL, "pasted", or (for DNS fields, filled by code) "dns:<TYPE> <name>". */
export const EvidenceUrlSchema = z.string().trim().min(1, "evidence_url is empty");

/** A fact with its evidence, or the literal "NOT_FOUND". */
export function evidenced<T extends z.ZodTypeAny>(value: T) {
  return z.union([
    z.literal(NOT_FOUND),
    z
      .object({
        value,
        evidence_url: EvidenceUrlSchema,
        evidence_quote: EvidenceQuoteSchema,
      })
      .strict(),
  ]);
}

export type Evidenced<T> = typeof NOT_FOUND | { value: T; evidence_url: string; evidence_quote: string };

export function isFound<F>(field: F): field is Exclude<F, typeof NOT_FOUND> {
  return field !== NOT_FOUND;
}
