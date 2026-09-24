import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import type { PageKind } from "@clearpath/shared";
import type { PageDate } from "../fetch/clean";
import type { SitemapResult } from "../fetch/site";
import { partialDateEnd } from "./score";

/** Pages whose dates never count: privacy, terms, legal, cookie, disclaimer, accessibility. */
export const POLICY_PATH = /(privacy|terms|legal|cookie|disclaimer|accessibility|policy)/i;

interface Candidate {
  date: string;
  source: "time_element" | "article_published_time" | "jsonld_date_published" | "jsonld_date_modified" | "sitemap_lastmod" | "url_date";
  url: string;
  raw: string;
}

function toPartialDate(raw: string): string | null {
  const m = /^\s*(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(raw);
  if (!m) return null;
  return m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`;
}

/**
 * Paths whose date says when a file was uploaded, not when content was published: WordPress media
 * uploads and any non-HTML file (images, PDFs, documents, feeds).
 */
export const NON_CONTENT_PATH = /\/wp-content\/uploads\/|\.(png|jpe?g|gif|webp|svg|ico|bmp|tiff?|pdf|zip|docx?|xlsx?|pptx?|csv|txt|mp3|mp4|mov|avi|ics|xml|json|css|js)$/i;

/** A /YYYY/MM/DD/ date in a URL path (WordPress-style post permalinks). Upload and file paths never count. */
export function urlPathDate(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (NON_CONTENT_PATH.test(path)) return null;
  const m = /\/((?:19|20)\d{2})\/(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])(?:\/|$)/.exec(path);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Deterministic freshness: the newest machine-readable date from page markup or the sitemap.
 * Policy pages never count; dates in the future (beyond one day) or before 1995 are ignored.
 * Copyright years and "founded" dates are never parsed in the first place. A /YYYY/MM/DD/ date in a
 * page or sitemap URL path (url_date) is lower confidence: used only when no other date exists.
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
    const fromPath = urlPathDate(p.url);
    if (fromPath) candidates.push({ date: fromPath, source: "url_date", url: p.url, raw: new URL(p.url).pathname });
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
      const fromPath = urlPathDate(e.loc);
      if (fromPath) candidates.push({ date: fromPath, source: "url_date", url: sitemap.url, raw: path });
    }
  }
  const valid = candidates.filter((c) => {
    const start = Date.UTC(Number(c.date.slice(0, 4)), Number(c.date.slice(5, 7)) - 1, c.date.length > 7 ? Number(c.date.slice(8, 10)) : 1);
    return c.date >= "1995" && start <= limit && partialDateEnd(c.date).getTime() > 0;
  });
  if (valid.length === 0) return NOT_FOUND;
  const confident = valid.filter((c) => c.source !== "url_date");
  const pool = confident.length > 0 ? confident : valid;
  const newest = pool.reduce((a, b) => (b.date > a.date ? b : a));
  return {
    value: { date: newest.date, source: newest.source },
    evidence_url: newest.url,
    evidence_quote: newest.raw.split(/\s+/).slice(0, 15).join(" "),
  };
}
