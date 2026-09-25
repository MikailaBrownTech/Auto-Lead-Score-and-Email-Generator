import fs from "node:fs";
import path from "node:path";
import { FIRM_TYPES, type FirmType } from "@clearpath/shared";
import { BlockError } from "./blocks";
import { DOC_FILES, DOCS_DIR } from "./loader";

/**
 * docs/09_sequences.md: the human-written Tier C sequence (no model call). The code fills merge fields.
 * Tiers A and B are written by the model (write/writer.ts). This module reads the file as the founder
 * wrote it (plain Markdown, no JSON).
 */

/** Filled per lead when the sequence is assembled. */
export const LEAD_FIELDS = ["firm", "firm_short", "city", "first_name", "approved_sentence"] as const;
/** Filled from docs/01 when an email is shown, checked, or exported (so later settings apply without a rewrite). */
export const SETTINGS_FIELDS = ["company", "offer", "booking_link", "region", "company_one_liner"] as const;
/** Only in the signature block. */
export const SIGNATURE_FIELDS = ["sender_name", "sender_title", "company", "website", "opt_out_line", "physical_address"] as const;
export type SettingsField = (typeof SETTINGS_FIELDS)[number];

const BODY_FIELDS: ReadonlySet<string> = new Set<string>([...LEAD_FIELDS, ...SETTINGS_FIELDS, "signature"]);

export interface EmailTemplate {
  n: number;
  /** Email 1: subject A. Emails 3-5: "Subject" / "Subject (if a new thread)". */
  subject_a: string | null;
  /** Email 1 only. */
  subject_b: string | null;
  /** Paragraphs from the first line to the one before {{signature}}. */
  paragraphs: string[];
  /** Email 1: the role-based opening paragraph (its first paragraph, unless that is a greeting); null otherwise. */
  roleLine: string | null;
}

export interface SegmentSwap {
  email3Subject: string;
  notes: string;
}

export interface TemplateSet {
  emails: Map<number, EmailTemplate>;
  /** "Segment swaps" table rows, by firm type. */
  segments: Partial<Record<FirmType, SegmentSwap>>;
  /** "Signature block" lines, with {{...}} fields. */
  signature: string[];
}

/** The segment types the file has rows for; any other type uses the cpa row (the default sequence). */
export const SEGMENT_TYPES = ["cpa", "tax_preparer", "bookkeeper", "payroll"] as const satisfies readonly FirmType[];

const fail = (msg: string): never => {
  throw new BlockError(`${DOC_FILES.templates}: ${msg}`);
};

/** "## Heading" sections: heading text -> lines. */
function sections(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      current = [];
      out.set(h[1]!, current);
    } else if (current) current.push(line);
  }
  return out;
}

function checkFields(where: string, text: string, allowed: ReadonlySet<string>): void {
  for (const [, name] of text.matchAll(/\{\{([^}]*)\}\}/g)) {
    if (!allowed.has(name!)) fail(`${where} uses unknown merge field {{${name}}}`);
  }
}

/** Paragraphs: blank-line separated blocks, lines inside a block kept (bullet lists stay one per line). */
function paragraphs(lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      if (cur.length) out.push(cur.join("\n"));
      cur = [];
    } else cur.push(line.trim());
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

function parseEmail(n: number, lines: string[]): EmailTemplate {
  let subject_a: string | null = null;
  let subject_b: string | null = null;
  const body: string[] = [];
  let sawSignature = false;
  for (const line of lines) {
    const t = line.trim();
    if (sawSignature) continue; // notes after the signature (e.g. "Sends only when ...") are not copy
    const subj = /^Subject(?:\s+([AB]))?(?:\s*\([^)]*\))?:\s*(.+)$/.exec(t);
    if (subj && body.every((l) => l.trim() === "")) {
      if (subj[1] === "B") subject_b = subj[2]!.trim();
      else subject_a = subj[2]!.trim();
      continue;
    }
    if (t === "{{signature}}") {
      sawSignature = true;
      continue;
    }
    body.push(line);
  }
  if (!sawSignature) fail(`email ${n} must end with a {{signature}} line`);
  const paras = paragraphs(body);
  if (paras.length === 0) fail(`email ${n} has no copy`);
  for (const p of [...paras, subject_a ?? "", subject_b ?? ""]) checkFields(`email ${n}`, p, BODY_FIELDS);
  let roleLine: string | null = null;
  if (n === 1) {
    if (!subject_a || !subject_b) fail("email 1 needs \"Subject A:\" and \"Subject B:\" lines");
    if (paras.length < 2) fail("email 1 needs a role-based opening paragraph and at least one more");
    if (!/^(hi|hello|dear)\b/i.test(paras[0]!)) roleLine = paras[0]!;
  }
  return { n, subject_a, subject_b, paragraphs: paras, roleLine };
}

export function parseTemplates(markdown: string): TemplateSet {
  const secs = sections(markdown);
  const emails = new Map<number, EmailTemplate>();
  let segments: TemplateSet["segments"] = {};
  let signature: string[] = [];
  for (const [heading, lines] of secs) {
    const email = /^Email\s+([1-5])\b/i.exec(heading);
    if (email) {
      const n = Number(email[1]);
      if (emails.has(n)) fail(`email ${n} appears twice`);
      emails.set(n, parseEmail(n, lines));
    } else if (/^Segment swaps/i.test(heading)) {
      segments = {};
      for (const line of lines) {
        const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (cells.length < 2 || !(FIRM_TYPES as readonly string[]).includes(cells[0]!)) continue;
        checkFields(`segment ${cells[0]}`, cells[1]!, BODY_FIELDS);
        segments[cells[0] as FirmType] = { email3Subject: cells[1]!, notes: cells[2] ?? "" };
      }
    } else if (/^Signature block/i.test(heading)) {
      signature = lines.map((l) => l.trim());
      while (signature.length && signature[0] === "") signature.shift();
      while (signature.length && signature.at(-1) === "") signature.pop();
      for (const l of signature) checkFields("the signature block", l, new Set(SIGNATURE_FIELDS));
    }
  }
  for (let n = 1; n <= 5; n++) if (!emails.has(n)) fail(`missing "## Email ${n}"`);
  if (signature.length === 0) fail(`missing "## Signature block"`);
  return { emails, segments, signature };
}

export const loadTemplates = (docsDir = DOCS_DIR) => parseTemplates(fs.readFileSync(path.join(docsDir, DOC_FILES.templates), "utf8"));

/** The segment row for a lead: its primary type if the file has a row for it, else the cpa default. */
export function segmentType(primary: FirmType | null, set: TemplateSet): FirmType {
  return primary && set.segments[primary] ? primary : "cpa";
}
