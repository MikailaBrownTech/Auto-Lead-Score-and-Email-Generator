import fs from "node:fs";
import path from "node:path";
import {
  normalizeText,
  RegulatoryConfigSchema,
  type ApprovedSentence,
  type RegulatoryConfig,
  OfferConfigSchema,
  EvidenceConfigSchema,
  ScoringConfigSchema,
  StyleConfigSchema,
  type OfferConfig,
  type RegulatoryFact,
  type EvidenceConfig,
  type ScoringConfig,
  type StyleConfig,
} from "@clearpath/shared";
import type { z } from "zod";
import { fromRoot } from "../config/paths";
import { BlockError, readBlock, writeBlock } from "./blocks";

export const DOCS_DIR = fromRoot("docs");
export const BACKUP_DIR = fromRoot("data/backups");

export const DOC_FILES = {
  offer: "01_offer_and_icp.md",
  regulatory: "02_regulatory_facts.md",
  style: "03_email_style_guide.md",
  scoring: "06_scoring_rubric.md",
  templates: "09_template_emails.md",
} as const;

/** A setting still holding its "[fill me in]" bracket text is treated as empty. */
export function isPlaceholder(value: string): boolean {
  return /^\s*\[[\s\S]*\]\s*$/.test(value);
}

function readDoc(docsDir: string, file: string): string {
  return fs.readFileSync(path.join(docsDir, file), "utf8");
}

function parseWith<S extends z.ZodTypeAny>(schema: S, raw: unknown, where: string): z.infer<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(block)"}: ${i.message}`);
    throw new BlockError(`${where} is invalid:\n${lines.join("\n")}`);
  }
  return parsed.data;
}

export function normalizeOffer(offer: OfferConfig): OfferConfig {
  const clean = (s: string) => (isPlaceholder(s) ? "" : s.trim());
  const founding = offer.founding_client_offer;
  return {
    ...offer,
    opt_out_line: clean(offer.opt_out_line),
    physical_address: clean(offer.physical_address),
    approved_proof: offer.approved_proof.map(clean).filter((s) => s !== ""),
    founding_client_offer:
      founding === null || isPlaceholder(founding) || founding.trim() === "" || founding.trim().toLowerCase() === "none"
        ? null
        : founding.trim(),
  };
}

export function parseOffer(markdown: string): OfferConfig {
  return normalizeOffer(parseWith(OfferConfigSchema, readBlock(markdown, "offer", DOC_FILES.offer), `${DOC_FILES.offer} clearpath:offer`));
}

export function parseStyle(markdown: string): StyleConfig {
  return parseWith(StyleConfigSchema, readBlock(markdown, "style", DOC_FILES.style), `${DOC_FILES.style} clearpath:style`);
}

export function parseEvidence(markdown: string): EvidenceConfig {
  return parseWith(EvidenceConfigSchema, readBlock(markdown, "evidence", DOC_FILES.scoring), `${DOC_FILES.scoring} clearpath:evidence`);
}

export function parseScoring(markdown: string): ScoringConfig {
  return parseWith(ScoringConfigSchema, readBlock(markdown, "scoring", DOC_FILES.scoring), `${DOC_FILES.scoring} clearpath:scoring`);
}

/**
 * docs/02: a bullet line reaches the writer only if it ends with the exact, uppercase marker
 * "VERIFIED" (optionally followed by a period). "Verified", "[VERIFY]" and anything else are excluded.
 */
export function parseVerifiedFacts(markdown: string): RegulatoryFact[] {
  const facts: RegulatoryFact[] = [];
  markdown.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*-\s+(.*\S)\s+VERIFIED\.?\s*$/.exec(line);
    if (!m) return;
    const text = m[1]!.replace(/[\s.]+$/, "") + ".";
    if (/\[\s*VERIFY/i.test(line)) return;
    facts.push({ id: i + 1, text });
  });
  return facts;
}

/** Dollar amounts or penalty language. Such facts never reach the writer, VERIFIED or not. */
export function isMoneyOrPenaltyFact(text: string): boolean {
  return /\$\s?\d|\b\d[\d,.]*\s?(dollars|usd)\b|\bpenalt(y|ies)\b|\bfines?\b/i.test(text);
}

/** The facts the writer may use: exact-VERIFIED lines minus any dollar-penalty facts. */
export function writerFacts(facts: RegulatoryFact[]): RegulatoryFact[] {
  return facts.filter((f) => !isMoneyOrPenaltyFact(f.text));
}

export function parseRegulatory(markdown: string): RegulatoryConfig {
  return parseWith(RegulatoryConfigSchema, readBlock(markdown, "regulatory", DOC_FILES.regulatory), `${DOC_FILES.regulatory} clearpath:regulatory`);
}

/** At most this many words in an approved sentence (it has to fit an email slot). */
export const MAX_APPROVED_SENTENCE_WORDS = 40;

/**
 * The approved sentences that may be inserted: each must restate a VERIFIED docs/02 line (its
 * source matches the start of that line), be one sentence, and mention no money or penalties.
 * Anything else is excluded with a reason (shown in reports and on the Settings screen).
 */
export function usableApprovedSentences(markdown: string): { sentences: ApprovedSentence[]; excluded: { id: string; reason: string }[] } {
  const config = parseRegulatory(markdown);
  const verified = parseVerifiedFacts(markdown);
  const norm = (s: string) => normalizeText(s).toLowerCase();
  const sentences: ApprovedSentence[] = [];
  const excluded: { id: string; reason: string }[] = [];
  for (const s of config.approved_sentences) {
    const fact = verified.find((f) => norm(f.text).startsWith(norm(s.source)));
    const reason = !fact
      ? `source "${s.source}" is not the start of a VERIFIED docs/02 line`
      : isMoneyOrPenaltyFact(fact.text) || isMoneyOrPenaltyFact(s.text)
        ? "mentions money or penalties"
        : !/[.?]$/.test(s.text) || /[.?!]\s+\S/.test(s.text)
          ? "must be exactly one sentence"
          : s.text.split(/\s+/).length > MAX_APPROVED_SENTENCE_WORDS
            ? `longer than ${MAX_APPROVED_SENTENCE_WORDS} words`
            : null;
    if (reason) excluded.push({ id: s.id, reason });
    else sentences.push(s);
  }
  return { sentences, excluded };
}

export const loadApprovedSentences = (docsDir = DOCS_DIR) => usableApprovedSentences(readDoc(docsDir, DOC_FILES.regulatory));

export const loadOffer = (docsDir = DOCS_DIR) => parseOffer(readDoc(docsDir, DOC_FILES.offer));
export const loadStyle = (docsDir = DOCS_DIR) => parseStyle(readDoc(docsDir, DOC_FILES.style));
export const loadScoring = (docsDir = DOCS_DIR) => parseScoring(readDoc(docsDir, DOC_FILES.scoring));
export const loadEvidence = (docsDir = DOCS_DIR) => parseEvidence(readDoc(docsDir, DOC_FILES.scoring));
export const loadVerifiedFacts = (docsDir = DOCS_DIR) => parseVerifiedFacts(readDoc(docsDir, DOC_FILES.regulatory));
export const loadWriterFacts = (docsDir = DOCS_DIR) => writerFacts(loadVerifiedFacts(docsDir));

const BLOCKS = {
  offer: { file: DOC_FILES.offer, parse: parseOffer, schema: OfferConfigSchema },
  style: { file: DOC_FILES.style, parse: parseStyle, schema: StyleConfigSchema },
  scoring: { file: DOC_FILES.scoring, parse: parseScoring, schema: ScoringConfigSchema },
  evidence: { file: DOC_FILES.scoring, parse: parseEvidence, schema: EvidenceConfigSchema },
  regulatory: { file: DOC_FILES.regulatory, parse: parseRegulatory, schema: RegulatoryConfigSchema },
} as const;
export type BlockName = keyof typeof BLOCKS;

export interface SaveOptions {
  docsDir?: string;
  backupDir?: string;
  now?: () => Date;
}

/**
 * Settings save path. Validates the new value, writes it into the block, re-parses the whole file,
 * and refuses the save unless the file parses back to the same settings. The previous file is
 * copied to data/backups/<file>.<timestamp>.bak first; the new file is written atomically.
 */
export function saveBlock(name: BlockName, value: unknown, opts: SaveOptions = {}): { backupPath: string } {
  const { file, parse, schema } = BLOCKS[name];
  const docsDir = opts.docsDir ?? DOCS_DIR;
  const backupDir = opts.backupDir ?? BACKUP_DIR;
  const target = path.join(docsDir, file);

  const validated = parseWith(schema as z.ZodTypeAny, value, `new ${name} settings`);
  const before = fs.readFileSync(target, "utf8");
  const after = writeBlock(before, name, validated, file);

  let reparsed: unknown;
  try {
    reparsed = parse(after);
  } catch (err) {
    throw new BlockError(`Save refused: ${file} would not parse back (${(err as Error).message})`);
  }
  const expected = name === "offer" ? normalizeOffer(validated as OfferConfig) : validated;
  if (JSON.stringify(reparsed) !== JSON.stringify(expected)) {
    throw new BlockError(`Save refused: ${file} did not round-trip to the same settings`);
  }

  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = (opts.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `${file}.${stamp}.bak`);
  fs.writeFileSync(backupPath, before, "utf8");

  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, after, "utf8");
  fs.renameSync(tmp, target);
  return { backupPath };
}
