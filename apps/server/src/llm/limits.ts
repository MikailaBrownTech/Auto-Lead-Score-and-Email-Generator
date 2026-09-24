import type { CallType } from "../db/schema";

/**
 * max_tokens per call type. Output is kept small: structured tool input only, no reasoning fields.
 * The full 16-field extraction with 15-word quotes fits well within 3000 tokens.
 */
export const MAX_OUTPUT_TOKENS: Record<CallType, number> = {
  smoke: 16,
  extract: 3000,
  extract_retry: 1500,
  write: 2500,
  /** One sentence (<= 30 words) plus the subject pick. */
  personal_line: 200,
  judge: 800,
};
