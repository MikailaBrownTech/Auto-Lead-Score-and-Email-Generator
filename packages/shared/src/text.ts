/** Words = whitespace-separated tokens. Used for quote limits and email word counts. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

const CURLY_SINGLE = new RegExp("[\\u2018\\u2019\\u201B\\u2032]", "g");
const CURLY_DOUBLE = new RegExp("[\\u201C\\u201D\\u201F\\u2033]", "g");
const DASHES = new RegExp("[\\u2013\\u2014]", "g");
const NBSP = new RegExp("\\u00A0", "g");

/** Straightens curly quotes and collapses whitespace so phrase and quote matching is predictable. */
export function normalizeText(text: string): string {
  return text
    .replace(CURLY_SINGLE, "'")
    .replace(CURLY_DOUBLE, '"')
    .replace(DASHES, "-")
    .replace(NBSP, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive phrase match (after normalizeText) that does not fire inside a longer word. */
export function containsPhrase(text: string, phrase: string): boolean {
  const p = normalizeText(phrase);
  const start = /^\w/.test(p) ? "\\b" : "";
  const end = /\w$/.test(p) ? "\\b" : "";
  return new RegExp(start + escapeRegex(p) + end, "i").test(normalizeText(text));
}
