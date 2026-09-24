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

/** One piece of evidence: where, and the exact words. */
export const EvidenceRefSchema = z.object({ evidence_url: EvidenceUrlSchema, evidence_quote: EvidenceQuoteSchema }).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

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

/**
 * A list fact whose items were each found by the code in the cleaned text of a fetched page
 * (normalized search), or "NOT_FOUND". The item text itself is the evidence; evidence_url is the page
 * it was found on. Used for services and software_mentioned.
 */
export function foundList<T extends z.ZodString | z.ZodEffects<z.ZodString>>(item: T) {
  return z.union([
    z.literal(NOT_FOUND),
    z
      .object({
        value: z.array(item).min(1),
        evidence: z.array(z.object({ item: z.string().trim().min(1), evidence_url: EvidenceUrlSchema }).strict()).min(1),
      })
      .strict()
      .refine((f) => f.value.length === f.evidence.length && f.value.every((v, i) => v === f.evidence[i]!.item), "each list item needs exactly one evidence entry, in order"),
  ]);
}

export type Evidenced<T> = typeof NOT_FOUND | { value: T; evidence_url: string; evidence_quote: string };
export type FoundList<T> = typeof NOT_FOUND | { value: T[]; evidence: { item: string; evidence_url: string }[] };

export function isFound<F>(field: F): field is Exclude<F, typeof NOT_FOUND> {
  return field !== NOT_FOUND;
}
