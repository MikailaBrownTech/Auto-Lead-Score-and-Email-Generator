import type { PageKind } from "@clearpath/shared";

/** Returns the exact token count of a text (backed by the count_tokens API, cached by hash). */
export type CountTokens = (text: string) => Promise<number>;

export interface CappedText {
  text: string;
  tokens: number;
  truncated: boolean;
}

/** Pages are admitted to the per-lead budget in this order. */
const KIND_ORDER: PageKind[] = ["home", "about", "team", "services", "contact", "privacy", "security", "other"];

/** A page is not worth sending if only this many tokens of budget are left for it. */
const MIN_USEFUL_TOKENS = 300;

/**
 * Cuts text to at most `cap` tokens at a paragraph boundary ("\n\n"), or at a word boundary if the
 * first paragraph alone is too long. Every candidate is measured with the API; the character-length
 * ratio is only used to choose where to try cutting next.
 */
export async function truncateToTokens(text: string, cap: number, count: CountTokens): Promise<CappedText> {
  let tokens = await count(text);
  if (tokens <= cap) return { text, tokens, truncated: false };

  const paragraphs = text.split(/\n\n/);
  let current = text;
  for (let attempt = 0; attempt < 8; attempt++) {
    const targetChars = Math.floor(current.length * (cap / tokens) * 0.95);
    let candidate = "";
    for (const p of paragraphs) {
      const next = candidate ? `${candidate}\n\n${p}` : p;
      if (next.length > targetChars) break;
      candidate = next;
    }
    if (!candidate) {
      // First paragraph alone is over the cap: cut it at a word boundary.
      const cut = paragraphs[0]!.slice(0, targetChars);
      candidate = cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).trimEnd();
    }
    if (!candidate || candidate === current) break;
    tokens = await count(candidate);
    current = candidate;
    if (tokens <= cap) return { text: current, tokens, truncated: true };
  }
  return { text: "", tokens: 0, truncated: true };
}

export interface CapInputPage {
  url: string;
  kind: PageKind | "pasted";
  text: string;
  nearEmpty: boolean;
}

export interface SentPage {
  url: string;
  kind: PageKind | "pasted";
  /** Exactly the text sent to the model (possibly truncated); quotes are verified against this. */
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * Applies the per-page cap and the per-lead input cap. Near-empty pages are not sent. Every cut or
 * skip is described in `failures` so it lands in the dossier.
 */
export async function applyTokenCaps(
  pages: CapInputPage[],
  caps: { perPage: number; perLead: number },
  count: CountTokens,
): Promise<{ sent: SentPage[]; failures: string[]; totalTokens: number }> {
  const ordered = [...pages].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind as PageKind) - KIND_ORDER.indexOf(b.kind as PageKind),
  );
  const sent: SentPage[] = [];
  const failures: string[] = [];
  let total = 0;

  for (const page of ordered) {
    if (page.nearEmpty || page.text.trim() === "") {
      failures.push(`not sent to the model: ${page.url} has almost no text`);
      continue;
    }
    let capped = await truncateToTokens(page.text, caps.perPage, count);
    if (capped.truncated) {
      failures.push(`truncated for the model: ${page.url} cut to ${capped.tokens} tokens at a paragraph boundary (per-page cap ${caps.perPage})`);
    }
    const remaining = caps.perLead - total;
    if (capped.tokens > remaining) {
      if (remaining < MIN_USEFUL_TOKENS) {
        failures.push(`not sent to the model: ${page.url} (per-lead input cap ${caps.perLead} tokens reached)`);
        continue;
      }
      capped = await truncateToTokens(capped.text, remaining, count);
      failures.push(`truncated for the model: ${page.url} cut to ${capped.tokens} tokens (per-lead input cap ${caps.perLead})`);
    }
    if (!capped.text) {
      failures.push(`not sent to the model: ${page.url} could not be cut to fit the token cap`);
      continue;
    }
    sent.push({ url: page.url, kind: page.kind, text: capped.text, tokens: capped.tokens, truncated: capped.truncated });
    total += capped.tokens;
  }
  return { sent, failures, totalTokens: total };
}
