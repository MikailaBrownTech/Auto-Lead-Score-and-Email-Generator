import { z } from "zod";
import { countWords } from "./text";

export const NOT_FOUND = "NOT_FOUND" as const;
export const MAX_QUOTE_WORDS = 15;
/** List fields (services, software) may cite up to this many separate quotes. */
export const MAX_LIST_QUOTES = 3;

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

/** A list fact backed by 1-3 separate quotes (split, never stitched), or "NOT_FOUND". */
export function evidencedList<T extends z.ZodTypeAny>(item: T) {
  return z.union([
    z.literal(NOT_FOUND),
    z
      .object({
        value: z.array(item).min(1),
        evidence: z.array(EvidenceRefSchema).min(1).max(MAX_LIST_QUOTES),
      })
      .strict(),
  ]);
}

export type Evidenced<T> = typeof NOT_FOUND | { value: T; evidence_url: string; evidence_quote: string };
export type EvidencedList<T> = typeof NOT_FOUND | { value: T[]; evidence: EvidenceRef[] };

export function isFound<F>(field: F): field is Exclude<F, typeof NOT_FOUND> {
  return field !== NOT_FOUND;
}
