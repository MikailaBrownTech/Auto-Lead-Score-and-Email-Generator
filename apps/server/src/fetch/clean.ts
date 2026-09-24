import crypto from "node:crypto";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";

/** Cleaned text shorter than this is "near-empty" (typically a JavaScript-rendered shell). */
export const NEAR_EMPTY_CHARS = 200;

export interface PageLink {
  href: string;
  text: string;
}

/** A machine-readable date found in the page markup (never a date written in the prose). */
export interface PageDate {
  date: string;
  source: "time_element" | "article_published_time" | "jsonld_date_published" | "jsonld_date_modified";
  raw: string;
}

export interface CleanedPage {
  dates: PageDate[];
  title: string;
  /** Visible text with paragraph breaks ("\n\n") preserved, for extraction and quote checks. */
  text: string;
  /** Text from hidden elements. Never used as evidence; kept for the prompt-injection scan. */
  hiddenText: string;
  links: PageLink[];
  nearEmpty: boolean;
  textSha256: string;
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "HEAD"]);
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
  "SECTION", "TABLE", "TR", "UL", "TD", "TH", "BODY",
]);

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden")) return true;
  if (el.getAttribute("aria-hidden") === "true") return true;
  const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  return /display:none|visibility:hidden|font-size:0(px)?(;|$)|opacity:0(;|$)/.test(style);
}

/** Text of a subtree with block boundaries as blank lines. */
function blockText(root: Node): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el.tagName === "BR") {
      out.push("\n");
      return;
    }
    const block = BLOCK_TAGS.has(el.tagName);
    if (block) out.push("\n\n");
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push("\n\n");
  };
  walk(root);
  return tidy(out.join(""));
}

function tidy(text: string): string {
  return text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Cloudflare email obfuscation: first byte is the XOR key for the rest. */
export function decodeCfEmail(hex: string): string | null {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2 !== 0) return null;
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : null;
}

/** Replaces Cloudflare-protected addresses with the real address, in text and in links. */
function decodeCloudflareEmails(doc: Document): void {
  for (const el of Array.from(doc.querySelectorAll("[data-cfemail]"))) {
    const email = decodeCfEmail(el.getAttribute("data-cfemail") ?? "");
    if (email) el.replaceWith(doc.createTextNode(email));
  }
  for (const a of Array.from(doc.querySelectorAll('a[href*="/cdn-cgi/l/email-protection"]'))) {
    const hash = (a.getAttribute("href") ?? "").split("#")[1] ?? "";
    const email = decodeCfEmail(hash);
    if (!email) continue;
    a.setAttribute("href", `mailto:${email}`);
    if (/email.?protected/i.test(a.textContent ?? "")) a.textContent = email;
  }
}

function toPartialDate(raw: string): string | null {
  const m = /^\s*(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12) return null;
  if (d !== undefined && (Number(d) < 1 || Number(d) > 31)) return null;
  return d ? `${y}-${mo}-${d}` : `${y}-${mo}`;
}

/**
 * Machine-readable dates only: <time datetime>, article:published_time, JSON-LD datePublished and
 * dateModified. Year-only values (a copyright year) never parse; foundingDate is never read.
 */
function extractDates(doc: Document): PageDate[] {
  const out: PageDate[] = [];
  const push = (raw: string | null | undefined, source: PageDate["source"]) => {
    const date = raw ? toPartialDate(raw) : null;
    if (date) out.push({ date, source, raw: raw!.trim().slice(0, 80) });
  };
  for (const t of Array.from(doc.querySelectorAll("time[datetime]"))) push(t.getAttribute("datetime"), "time_element");
  for (const m of Array.from(doc.querySelectorAll('meta[property="article:published_time"]'))) push(m.getAttribute("content"), "article_published_time");
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? "");
    } catch {
      continue;
    }
    const visit = (node: unknown, depth: number) => {
      if (depth > 6 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) return node.forEach((n) => visit(n, depth + 1));
      const o = node as Record<string, unknown>;
      if (typeof o.datePublished === "string") push(o.datePublished, "jsonld_date_published");
      if (typeof o.dateModified === "string") push(o.dateModified, "jsonld_date_modified");
      for (const v of Object.values(o)) if (typeof v === "object") visit(v, depth + 1);
    };
    visit(data, 0);
  }
  return out;
}

/**
 * HTML -> clean text. jsdom never runs scripts or loads subresources here (no runScripts, no
 * resources option). Hidden elements are removed from the visible text and returned separately.
 */
export function cleanHtml(html: string, pageUrl: string): CleanedPage {
  const dom = new JSDOM(html, { url: pageUrl, virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  decodeCloudflareEmails(doc);
  const dates = extractDates(doc);

  const links: PageLink[] = Array.from(doc.querySelectorAll("a[href]")).map((a) => ({
    href: (a as HTMLAnchorElement).href,
    text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));

  const hiddenParts: string[] = [];
  for (const el of Array.from(doc.body?.querySelectorAll("*") ?? [])) {
    if (el.isConnected && isHidden(el)) {
      const t = blockText(el);
      if (t) hiddenParts.push(t);
      el.remove();
    }
  }
  // Comments can carry injected instructions too; keep them only for the scan.
  const walker = doc.createTreeWalker(doc, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? "").trim();
    if (t) hiddenParts.push(t);
  }

  const bodyText = doc.body ? blockText(doc.body) : "";
  const footerText = Array.from(doc.querySelectorAll("footer, address"))
    .map((el) => blockText(el))
    .filter(Boolean)
    .join("\n\n");
  const navLabels = [...new Set(Array.from(doc.querySelectorAll("nav a")).map((a) => (a.textContent ?? "").trim()).filter(Boolean))];

  let main = "";
  try {
    const article = new Readability(doc.cloneNode(true) as Document).parse();
    if (article?.content) main = blockText(JSDOM.fragment(article.content));
  } catch {
    main = "";
  }
  // Small-firm sites often put team, contact, and service details outside the "article"; fall back
  // to the whole visible body when Readability keeps only a sliver of it.
  if (main.length < 500 || main.length < bodyText.length * 0.3) main = bodyText;

  const parts = [main];
  if (footerText && !main.includes(footerText.slice(0, 80))) parts.push(footerText);
  const contacts = links
    .filter((l) => /^(mailto|tel):/i.test(l.href))
    .map((l) => decodeURIComponent(l.href.replace(/^(mailto|tel):/i, "").split("?")[0]!))
    .filter((c) => c && !main.includes(c));
  if (contacts.length > 0) parts.push(`Contact links: ${[...new Set(contacts)].join(", ")}`);
  const missingNav = navLabels.filter((l) => !main.includes(l));
  if (missingNav.length > 0) parts.push(`Site navigation: ${navLabels.join(" | ")}`);

  const text = tidy(parts.join("\n\n"));
  const title = (doc.title ?? "").trim();
  dom.window.close();
  return {
    dates,
    title,
    text,
    hiddenText: tidy(hiddenParts.join("\n\n")),
    links,
    nearEmpty: text.length < NEAR_EMPTY_CHARS,
    textSha256: sha256(text),
  };
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
