import { containsPhrase, type PageKind, type SecurityMentionSearch } from "@clearpath/shared";

export interface SearchablePage {
  url: string;
  kind: PageKind;
  httpStatus: number;
  contentType: string;
  truncated: boolean;
  /** Full cleaned text (not the token-capped copy sent to the model). */
  text: string;
  sha256: string;
}

/**
 * Deterministic keyword search over cleaned page text. Records every page searched with its hash,
 * so the "no WISP/security mention" score can be audited and reproduced.
 */
export function searchSecurityMentions(pages: SearchablePage[], keywords: string[]): Exclude<SecurityMentionSearch, "NOT_CHECKED"> {
  const matches: { url: string; keyword: string }[] = [];
  for (const page of pages) {
    for (const keyword of keywords) {
      if (containsPhrase(page.text, keyword)) matches.push({ url: page.url, keyword });
    }
  }
  return {
    keywords: [...keywords],
    pages: pages.map((p) => ({
      url: p.url,
      kind: p.kind,
      http_status: p.httpStatus,
      content_type: p.contentType,
      truncated: p.truncated,
      text_chars: p.text.length,
      sha256: p.sha256,
    })),
    matches,
  };
}
