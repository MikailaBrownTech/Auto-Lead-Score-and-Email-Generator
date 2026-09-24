import fs from "node:fs";
import type { PageKind } from "@clearpath/shared";
import { z } from "zod";
import { fromRoot } from "../config/paths";
import type { PageLink } from "./clean";

/** Core subpages (about, team, services, contact, privacy, security); one news article is added on top. */
export const MAX_SUBPAGES = 5;

type CoreKind = "about" | "team" | "services" | "contact" | "privacy" | "security";

/** Subpage kinds in the order they are chosen when a site has more than five candidates. */
const PRIORITY: CoreKind[] = ["about", "team", "services", "contact", "privacy", "security"];

const KIND_PATTERNS: Record<CoreKind, { path: RegExp; text: RegExp }> = {
  about: { path: /about|our-story|who-we-are|our-firm|history/i, text: /\babout\b|our story|who we are|our firm/i },
  team: { path: /team|staff|people|professionals|leadership|partners|bios?\b/i, text: /\bteam\b|staff|our people|professionals|leadership|partners/i },
  services: { path: /services?|what-we-do|solutions|practice-areas/i, text: /services?|what we do|solutions/i },
  contact: { path: /contact|locations?|directions/i, text: /contact|locations?|directions/i },
  privacy: { path: /privacy/i, text: /privacy/i },
  security: { path: /security|safeguard|data-protection/i, text: /security|safeguard|data protection/i },
};

/** Articles are not a firm's about/services/security pages, even when their titles use those words. */
const ARTICLE_PATH = /\/(blog|news|articles?|posts?|insights|resources|press|events|updates)\//i;

const SkipPatternsSchema = z.object({ patterns: z.array(z.string().min(1)) });

export function loadSkipPatterns(file = fromRoot("config/skip-patterns.json")): RegExp[] {
  const parsed = SkipPatternsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return parsed.patterns.map((p) => new RegExp(p, "i"));
}

/** "www.example.com" and "example.com" count as the same site. */
export function siteKey(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function classifyPage(url: URL, linkText = ""): PageKind {
  if (url.pathname === "/" || url.pathname === "") return "home";
  if (ARTICLE_PATH.test(url.pathname)) {
    // A single article (/blog/some-post), not an index (/blog/) or archive (skipped by pattern).
    const segments = url.pathname.split("/").filter(Boolean);
    return segments.length >= 2 ? "news" : "other";
  }
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

export interface DiscoveredLink {
  url: string;
  text: string;
  kind: PageKind;
  decision: "selected" | "skipped by pattern" | "not selected (kind already chosen)" | "not selected (limit reached)" | "not a candidate kind";
}

/**
 * Picks up to five same-site core subpages (one per kind, in priority order) plus one news/blog
 * article. Skips other sites, non-http links, and anything matching the skip patterns (archives,
 * tags, logins, files). Every internal link found is reported with the decision made about it.
 */
export function selectSubpagesDetailed(
  homeUrl: string,
  links: PageLink[],
  skip: RegExp[],
  max = MAX_SUBPAGES,
): { chosen: SubpageChoice[]; discovered: DiscoveredLink[] } {
  const home = new URL(homeUrl);
  const candidates = new Map<PageKind, string>();
  const discovered: DiscoveredLink[] = [];
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
    const kind = classifyPage(url, link.text);
    const entry: DiscoveredLink = { url: url.toString(), text: link.text.slice(0, 60), kind, decision: "not a candidate kind" };
    discovered.push(entry);
    if (skip.some((re) => re.test(url.pathname + url.search))) {
      entry.decision = "skipped by pattern";
      continue;
    }
    if (kind === "home" || kind === "other") continue;
    if (candidates.has(kind)) {
      entry.decision = "not selected (kind already chosen)";
      continue;
    }
    candidates.set(kind, url.toString());
  }

  const core = PRIORITY.filter((k) => candidates.has(k)).slice(0, max);
  const chosen: SubpageChoice[] = core.map((kind) => ({ url: candidates.get(kind)!, kind }));
  if (candidates.has("news")) chosen.push({ url: candidates.get("news")!, kind: "news" });
  const chosenUrls = new Set(chosen.map((c) => c.url));
  for (const d of discovered) {
    if (chosenUrls.has(d.url)) d.decision = "selected";
    else if (d.decision === "not a candidate kind" && candidates.get(d.kind) === d.url) d.decision = "not selected (limit reached)";
  }
  return { chosen, discovered };
}

export function selectSubpages(homeUrl: string, links: PageLink[], skip: RegExp[], max = MAX_SUBPAGES): SubpageChoice[] {
  return selectSubpagesDetailed(homeUrl, links, skip, max).chosen;
}
