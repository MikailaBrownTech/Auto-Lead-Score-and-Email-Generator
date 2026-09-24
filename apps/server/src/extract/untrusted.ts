import fs from "node:fs";
import type { InjectionFinding } from "@clearpath/shared";
import { z } from "zod";
import { fromRoot } from "../config/paths";

export const BLOCK_TAG = "untrusted_page";

/** Stops page text from opening or closing our delimiter blocks. */
export function neutralize(text: string): string {
  return text.replace(/untrusted[_\s-]*page/gi, "untrusted-page(text)");
}

function attr(value: string): string {
  return value.replace(/[<>"&\r\n]/g, (c) => encodeURIComponent(c));
}

/** Wraps one page's text as an untrusted data block. Only ever placed in the user message. */
export function pageBlock(page: { url: string; kind: string; title?: string; text: string }): string {
  const title = page.title ? ` title="${attr(neutralize(page.title))}"` : "";
  return `<${BLOCK_TAG} url="${attr(page.url)}" kind="${attr(page.kind)}"${title}>\n${neutralize(page.text)}\n</${BLOCK_TAG}>`;
}

const PatternsSchema = z.object({ patterns: z.array(z.string().min(1)).min(1) });

export function loadInjectionPatterns(file = fromRoot("config/injection-patterns.json")): RegExp[] {
  return PatternsSchema.parse(JSON.parse(fs.readFileSync(file, "utf8"))).patterns.map((p) => new RegExp(p, "im"));
}

function snippet(paragraph: string): string {
  const words = paragraph.replace(/\s+/g, " ").trim().split(" ");
  const s = words.slice(0, 40).join(" ") + (words.length > 40 ? " ..." : "");
  return s.slice(0, 300);
}

/**
 * Pattern scan for text that tries to instruct an AI. Visible text is scanned paragraph by paragraph;
 * hidden text (display:none, aria-hidden, HTML comments) is scanned too, since it is a common hiding
 * place. Findings flag the lead; the text is still treated as data either way.
 */
export function scanForInjection(
  pages: { url: string; text: string; hiddenText: string }[],
  patterns: RegExp[],
): InjectionFinding[] {
  const findings: InjectionFinding[] = [];
  for (const page of pages) {
    for (const [where, text] of [
      ["visible", page.text],
      ["hidden", page.hiddenText],
    ] as const) {
      for (const paragraph of text.split(/\n{2,}/)) {
        if (patterns.some((re) => re.test(paragraph))) {
          findings.push({ url: page.url, where, snippet: snippet(paragraph) });
        }
      }
    }
  }
  return findings;
}
