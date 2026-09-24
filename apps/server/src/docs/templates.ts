import fs from "node:fs";
import path from "node:path";
import { FIRM_TYPES, type FirmType, type OfferConfig, type SequenceEmail, type StyleConfig } from "@clearpath/shared";
import { BlockError } from "./blocks";
import { DOC_FILES, DOCS_DIR } from "./loader";

export interface EmailTemplate {
  subject_a: string | null;
  subject_b: string | null;
  body: string;
}

export type TemplateSet = Map<string, EmailTemplate>;

export const TEMPLATE_VARIABLES = ["greeting", "firm_ref", "cta_url"] as const;
export type TemplateVars = Record<(typeof TEMPLATE_VARIABLES)[number], string>;

export const REQUIRED_TEMPLATES = [
  "email1",
  ...FIRM_TYPES.filter((t) => t !== "credit_repair").map((t) => `email2.${t}`),
  "email3.checklist",
  "email3.scorecard",
  "email4",
  "email5",
];

const TEMPLATE_BLOCK_RE = /^```text clearpath:template ([a-z0-9_.]+)[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

function parseOne(name: string, raw: string): EmailTemplate {
  const lines = raw.split(/\r?\n/);
  const sep = lines.findIndex((l) => l.trim() === "---");
  const headerLines = sep === -1 ? [] : lines.slice(0, sep);
  const bodyLines = sep === -1 ? lines : lines.slice(sep + 1);
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const m = /^(subject_a|subject_b):\s*(.+)$/.exec(line.trim());
    if (!m) throw new BlockError(`${DOC_FILES.templates}: template ${name} has an unknown header line "${line}"`);
    headers[m[1]!] = m[2]!.trim();
  }
  const body = bodyLines.join("\n").trim();
  if (!body) throw new BlockError(`${DOC_FILES.templates}: template ${name} has an empty body`);
  for (const [, v] of `${body} ${Object.values(headers).join(" ")}`.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!(TEMPLATE_VARIABLES as readonly string[]).includes(v!)) {
      throw new BlockError(`${DOC_FILES.templates}: template ${name} uses unknown variable {{${v}}}`);
    }
  }
  return { subject_a: headers.subject_a ?? null, subject_b: headers.subject_b ?? null, body };
}

export function parseTemplates(markdown: string): TemplateSet {
  const set: TemplateSet = new Map();
  for (const m of markdown.matchAll(TEMPLATE_BLOCK_RE)) {
    const name = m[1]!;
    if (set.has(name)) throw new BlockError(`${DOC_FILES.templates}: template ${name} appears twice`);
    set.set(name, parseOne(name, m[2]!));
  }
  const missing = REQUIRED_TEMPLATES.filter((n) => !set.has(n));
  if (missing.length > 0) throw new BlockError(`${DOC_FILES.templates}: missing templates ${missing.join(", ")}`);
  const e1 = set.get("email1")!;
  if (!e1.subject_a || !e1.subject_b) throw new BlockError(`${DOC_FILES.templates}: email1 needs subject_a and subject_b`);
  return set;
}

export const loadTemplates = (docsDir = DOCS_DIR) =>
  parseTemplates(fs.readFileSync(path.join(docsDir, DOC_FILES.templates), "utf8"));

export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{([a-z_]+)\}\}/g, (_, name: string) => {
    const value = vars[name as keyof TemplateVars];
    if (value === undefined) throw new BlockError(`no value for template variable {{${name}}}`);
    return value;
  });
}

/** Greeting per docs/03: first name if known, otherwise "Hi,". */
export function greetingFor(decisionMakerName: string | null): string {
  const first = decisionMakerName?.trim().split(/\s+/)[0];
  return first ? `Hi ${first},` : "Hi,";
}

/**
 * Renders template email n (1-5). Email 2 is picked by firm type (falling back to "other");
 * email 3 by the offer's cta_type (checklist or scorecard).
 */
export function templateEmail(
  templates: TemplateSet,
  n: number,
  firmType: FirmType | null,
  vars: TemplateVars,
  style: StyleConfig,
  ctaType: OfferConfig["cta_type"],
): SequenceEmail {
  const name = n === 2 ? `email2.${firmType ?? "other"}` : n === 3 ? `email3.${ctaType}` : `email${n}`;
  const t = templates.get(name) ?? (n === 2 ? templates.get("email2.other") : undefined);
  if (!t) throw new BlockError(`template ${name} not found`);
  return {
    n,
    send_day: style.send_days[n - 1]!,
    subject_a: t.subject_a ? renderTemplate(t.subject_a, vars) : null,
    subject_b: t.subject_b ? renderTemplate(t.subject_b, vars) : null,
    body: renderTemplate(t.body, vars),
    grounding: [],
    template: true,
  };
}
