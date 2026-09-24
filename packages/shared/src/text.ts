/** Words = whitespace-separated tokens. Used for quote limits and email word counts. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

/** Straightens curly quotes and collapses whitespace so phrase and quote matching is predictable. */
export function normalizeText(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
