import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import type { PageKind } from "@clearpath/shared";
import type { PageDate } from "../fetch/clean";
import type { SitemapResult } from "../fetch/site";
import { partialDateEnd } from "./score";

/** Pages whose dates never count: privacy, terms, legal, cookie, disclaimer, accessibility. */
export const POLICY_PATH = /(privacy|terms|legal|cookie|disclaimer|accessibility|policy)/i;

interface Candidate {
  date: string;
  source: "time_element" | "article_published_time" | "jsonld_date_published" | "jsonld_date_modified" | "sitemap_lastmod";
  url: string;
  raw: string;
}

function toPartialDate(raw: string): string | null {
  const m = /^\s*(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(raw);
  if (!m) return null;
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

/**
 * Deterministic freshness: the newest machine-readable date from page markup or the sitemap.
 * Policy pages never count; dates in the future (beyond one day) or before 1995 are ignored.
 * Copyright years and "founded" dates are never parsed in the first place.
 */
export function computeFreshness(
  pages: { url: string; kind: PageKind; dates: PageDate[] }[],
  sitemap: SitemapResult | null,
  now: Date,
): Dossier["latest_dated_content"] {
  const limit = now.getTime() + 86_400_000;
  const candidates: Candidate[] = [];
  for (const p of pages) {
    if (p.kind === "privacy" || POLICY_PATH.test(new URL(p.url).pathname)) continue;
    for (const d of p.dates) candidates.push({ date: d.date, source: d.source, url: p.url, raw: d.raw });
  }
  if (sitemap) {
    for (const e of sitemap.entries) {
      let path = "";
      try {
        path = new URL(e.loc).pathname;
      } catch {
        continue;
      }
      if (POLICY_PATH.test(path)) continue;
      const date = toPartialDate(e.lastmod);
      if (date) candidates.push({ date, source: "sitemap_lastmod", url: sitemap.url, raw: `${e.loc} lastmod ${e.lastmod}` });
    }
  }
  const valid = candidates.filter((c) => {
    const start = Date.UTC(Number(c.date.slice(0, 4)), Number(c.date.slice(5, 7)) - 1, c.date.length > 7 ? Number(c.date.slice(8, 10)) : 1);
    return c.date >= "1995" && start <= limit && partialDateEnd(c.date).getTime() > 0;
  });
  if (valid.length === 0) return NOT_FOUND;
  const newest = valid.reduce((a, b) => (b.date > a.date ? b : a));
  return {
    value: { date: newest.date, source: newest.source },
    evidence_url: newest.url,
    evidence_quote: newest.raw.split(/\s+/).slice(0, 15).join(" "),
  };
}
