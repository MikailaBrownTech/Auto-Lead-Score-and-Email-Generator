import fs from "node:fs";
import type { PageKind } from "@clearpath/shared";
import { z } from "zod";
import { fromRoot } from "../config/paths";
import type { PageLink } from "./clean";

export const MAX_SUBPAGES = 5;

/** Subpage kinds in the order they are chosen when a site has more than five candidates. */
const PRIORITY: Exclude<PageKind, "home" | "other">[] = ["about", "team", "services", "contact", "privacy", "security"];

const KIND_PATTERNS: Record<Exclude<PageKind, "home" | "other">, { path: RegExp; text: RegExp }> = {
  about: { path: /about|our-story|who-we-are|our-firm|history/i, text: /\babout\b|our story|who we are|our firm/i },
  team: { path: /team|staff|people|professionals|leadership|partners|bios?\b/i, text: /\bteam\b|staff|our people|professionals|leadership|partners/i },
  services: { path: /services?|what-we-do|solutions|practice-areas/i, text: /services?|what we do|solutions/i },
  contact: { path: /contact|locations?|directions/i, text: /contact|locations?|directions/i },
  privacy: { path: /privacy/i, text: /privacy/i },
  security: { path: /security|safeguard|data-protection/i, text: /security|safeguard|data protection/i },
};

const SkipPatternsSchema = z.object({ patterns: z.array(z.string().min(1)) });

export function loadSkipPatterns(file = fromRoot("config/skip-patterns.json")): RegExp[] {
  const parsed = SkipPatternsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return parsed.patterns.map((p) => new RegExp(p, "i"));
}

/** "www.example.com" and "example.com" count as the same site. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

/** Articles are not a firm's about/services/security pages, even when their titles use those words. */
const ARTICLE_PATH = /\/(blog|news|articles?|posts?|insights|resources|press|events)\//i;

export function classifyPage(url: URL, linkText = ""): PageKind {
  if (url.pathname === "/" || url.pathname === "") return "home";
  if (ARTICLE_PATH.test(url.pathname)) return "other";
  for (const kind of PRIORITY) {
    const p = KIND_PATTERNS[kind];
    if (p.path.test(url.pathname) || p.text.test(linkText)) return kind;
  }
  return "other";
}

export interface SubpageChoice {
  url: string;
  kind: PageKind;
}

/**
 * Picks up to five same-site subpages from the homepage's links: one per kind, in priority order.
 * Skips other sites, non-http links, fragments of the homepage, and anything matching the skip patterns.
 */
export function selectSubpages(homeUrl: string, links: PageLink[], skip: RegExp[], max = MAX_SUBPAGES): SubpageChoice[] {
  const home = new URL(homeUrl);
  const candidates = new Map<PageKind, string>();
  const seen = new Set<string>([home.origin + home.pathname]);

  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.href, home);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (siteKey(url.hostname) !== siteKey(home.hostname)) continue;
    url.hash = "";
    const key = url.origin + url.pathname;
    if (seen.has(key)) continue;
    seen.add(key);
    const pathAndQuery = url.pathname + url.search;
    if (skip.some((re) => re.test(pathAndQuery))) continue;
    const kind = classifyPage(url, link.text);
    if (kind === "home" || kind === "other") continue;
    if (!candidates.has(kind)) candidates.set(kind, url.toString());
  }

  return PRIORITY.filter((k) => candidates.has(k))
    .slice(0, max)
    .map((kind) => ({ url: candidates.get(kind)!, kind }));
}
