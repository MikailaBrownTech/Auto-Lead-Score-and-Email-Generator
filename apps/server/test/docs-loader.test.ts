import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlockError, readBlock, writeBlock } from "../src/docs/blocks";
import {
  DOC_FILES,
  DOCS_DIR,
  isMoneyOrPenaltyFact,
  isPlaceholder,
  loadOffer,
  loadWriterFacts,
  loadScoring,
  loadStyle,
  loadVerifiedFacts,
  parseOffer,
  parseVerifiedFacts,
  saveBlock,
  writerFacts,
} from "../src/docs/loader";

describe("real docs (tests run against the files in docs/)", () => {
  it("docs/06 scoring weights sum to 100 and tiers are ordered", () => {
    const s = loadScoring();
    expect(s.criteria.reduce((a, c) => a + c.points, 0)).toBe(100);
    expect(s.tiers.A).toBeGreaterThan(s.tiers.B);
  });

  it("docs/06 no longer mentions 'plausible small firm'", () => {
    const text = fs.readFileSync(path.join(DOCS_DIR, DOC_FILES.scoring), "utf8");
    expect(text.toLowerCase()).not.toContain("plausible");
  });

  it("docs/03 banned list is non-empty and covers every quoted phrase in the BANNED prose line", () => {
    const style = loadStyle();
    expect(style.banned_phrases.length).toBeGreaterThan(0);
    const text = fs.readFileSync(path.join(DOCS_DIR, DOC_FILES.style), "utf8");
    const bannedLine = text.split(/\r?\n/).find((l) => l.startsWith("BANNED:"))!;
    const quoted = [...bannedLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).filter((q) => q !== "Re:");
    const listed = style.banned_phrases.map((p) => p.toLowerCase());
    for (const q of quoted) expect(listed, `"${q}" missing from banned_phrases`).toContain(q.toLowerCase());
  });

  it("docs/03 has send days 0, 3, 7, 12, 18 and an angle list for every firm type", () => {
    const style = loadStyle();
    expect(style.send_days).toEqual([0, 3, 7, 12, 18]);
    expect(Object.keys(style.firm_type_angles).sort()).toEqual(
      ["bookkeeper", "collections", "cpa", "credit_counseling", "credit_repair", "other", "payroll", "tax_preparer"],
    );
  });

  it("docs/01 offer parses; unfilled settings are empty, so no proof can be claimed", () => {
    const offer = loadOffer();
    expect(offer.sender_name).toBe("Mikaila Brown");
    expect(offer.cta_url).toBe("https://www.clearpathsecure.com/contact");
    expect(offer.approved_proof).toEqual([]);
  });

  it("docs/02: no [VERIFY] line and no non-exact marker ever reaches the writer", () => {
    const facts = loadVerifiedFacts();
    for (const f of facts) expect(f.text).not.toMatch(/\[\s*VERIFY/i);
    const text = fs.readFileSync(path.join(DOCS_DIR, DOC_FILES.regulatory), "utf8");
    const exact = text.split(/\r?\n/).filter((l) => /^\s*-\s.*\sVERIFIED\.?\s*$/.test(l) && !/\[\s*VERIFY/i.test(l));
    expect(facts).toHaveLength(exact.length);
  });
});

describe("writer facts never include dollar-penalty facts", () => {
  it("drops money and penalty lines even when marked VERIFIED", () => {
    const facts = parseVerifiedFacts(
      [
        "- Requires a written information security program. VERIFIED",
        "- Maximum civil penalty per violation: $50,000. VERIFIED",
        "- Violations can bring fines. VERIFIED",
        "- Penalties apply per day. VERIFIED",
      ].join("\n"),
    );
    expect(writerFacts(facts).map((f) => f.text)).toEqual(["Requires a written information security program."]);
  });

  it("the real docs/02 writer facts contain no dollar amounts or penalties", () => {
    for (const f of loadWriterFacts()) expect(f.text).not.toMatch(/\$\s?\d|penalt|\bfines?\b/i);
    expect(isMoneyOrPenaltyFact("Maximum civil penalty per violation: $50,000.")).toBe(true);
  });
});

describe("parseVerifiedFacts", () => {
  const doc = [
    "# Regulatory facts",
    "- Fact one is true. VERIFIED",
    "- Fact two, checked. VERIFIED.",
    "- Fact three. Verified",
    "- Fact four. [VERIFY]",
    "- Fact five [VERIFY against irs.gov] VERIFIED",
    "- Fact six. verified",
    "- Fact seven mentions VERIFIED in the middle of text",
    "Not a bullet. VERIFIED",
  ].join("\n");

  it("accepts only bullet lines ending in the exact uppercase VERIFIED marker", () => {
    const facts = parseVerifiedFacts(doc);
    expect(facts.map((f) => f.text)).toEqual(["Fact one is true.", "Fact two, checked."]);
    expect(facts.map((f) => f.id)).toEqual([2, 3]);
  });

  it("handles CRLF files", () => {
    expect(parseVerifiedFacts(doc.replace(/\n/g, "\r\n"))).toHaveLength(2);
  });
});

describe("config blocks", () => {
  const md = "# Title\n\nProse stays.\n\n```json clearpath:demo\n{\n  \"a\": 1\n}\n```\n\nMore prose.\n";

  it("reads and writes only the block, leaving prose byte-identical", () => {
    expect(readBlock(md, "demo")).toEqual({ a: 1 });
    const out = writeBlock(md, "demo", { a: 2, b: [1] });
    expect(readBlock(out, "demo")).toEqual({ a: 2, b: [1] });
    expect(out.startsWith("# Title\n\nProse stays.\n\n")).toBe(true);
    expect(out.endsWith("```\n\nMore prose.\n")).toBe(true);
  });

  it("preserves CRLF line endings", () => {
    const crlf = md.replace(/\n/g, "\r\n");
    const out = writeBlock(crlf, "demo", { a: 3 });
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(readBlock(out, "demo")).toEqual({ a: 3 });
  });

  it("errors on missing, duplicate, or invalid JSON blocks", () => {
    expect(() => readBlock("no block", "demo")).toThrow(BlockError);
    expect(() => readBlock(md + md, "demo")).toThrow(/more than one/);
    expect(() => readBlock(md.replace('"a": 1', "a: 1"), "demo")).toThrow(/not valid JSON/);
  });
});

describe("placeholders in docs/01", () => {
  it("treats [bracketed] values as empty", () => {
    expect(isPlaceholder("[your business mailing address]")).toBe(true);
    expect(isPlaceholder("123 Main St")).toBe(false);
    const md = [
      "```json clearpath:offer",
      JSON.stringify({
        sender_name: "Mikaila Brown",
        cta_url: "https://www.clearpathsecure.com/contact",
        opt_out_line: "[e.g. reply no]",
        physical_address: " [address] ",
        approved_proof: ["[Leave empty until true]", ""],
        founding_client_offer: "[approved wording, or none]",
      }),
      "```",
    ].join("\n");
    const offer = parseOffer(md);
    expect(offer).toMatchObject({ opt_out_line: "", physical_address: "", approved_proof: [], founding_client_offer: null });
  });
});

describe("saveBlock (Settings write-back)", () => {
  let dir: string;
  let docsDir: string;
  let backupDir: string;
  const now = () => new Date("2026-09-23T10:00:00.000Z");

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-docs-"));
    docsDir = path.join(dir, "docs");
    backupDir = path.join(dir, "backups");
    fs.mkdirSync(docsDir);
    for (const f of Object.values(DOC_FILES)) fs.copyFileSync(path.join(DOCS_DIR, f), path.join(docsDir, f));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the new weights, keeps a .bak of the old file, and reloads the same values", () => {
    const scoring = loadScoring(docsDir);
    const before = fs.readFileSync(path.join(docsDir, DOC_FILES.scoring), "utf8");
    scoring.criteria[0]!.points -= 5;
    scoring.criteria[1]!.points += 5;
    const { backupPath } = saveBlock("scoring", scoring, { docsDir, backupDir, now });
    expect(loadScoring(docsDir)).toEqual(scoring);
    expect(fs.readFileSync(backupPath, "utf8")).toBe(before);
    expect(path.basename(backupPath)).toBe(`${DOC_FILES.scoring}.2026-09-23T10-00-00-000Z.bak`);
    const after = fs.readFileSync(path.join(docsDir, DOC_FILES.scoring), "utf8");
    expect(after.split("```json")[0]).toBe(before.split("```json")[0]);
  });

  it("rejects weights that do not sum to 100 and leaves the file untouched with no backup", () => {
    const scoring = loadScoring(docsDir);
    const before = fs.readFileSync(path.join(docsDir, DOC_FILES.scoring), "utf8");
    scoring.criteria[0]!.points += 1;
    expect(() => saveBlock("scoring", scoring, { docsDir, backupDir, now })).toThrow(/sum to 100/);
    expect(fs.readFileSync(path.join(docsDir, DOC_FILES.scoring), "utf8")).toBe(before);
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  it("rejects a save when the file would not parse back (e.g. a second block was added by hand)", () => {
    const file = path.join(docsDir, DOC_FILES.style);
    const text = fs.readFileSync(file, "utf8");
    const block = text.slice(text.indexOf("```json clearpath:style"));
    fs.writeFileSync(file, text + "\n" + block);
    expect(() => saveBlock("style", loadStyle(DOCS_DIR), { docsDir, backupDir, now })).toThrow(BlockError);
  });

  it("saves offer settings (opt-out line, address) and reads them back", () => {
    const offer = loadOffer(docsDir);
    const updated = { ...offer, opt_out_line: "Reply 'no' and I won't email again.", physical_address: "1 Test St" };
    saveBlock("offer", updated, { docsDir, backupDir, now });
    expect(loadOffer(docsDir)).toEqual(updated);
  });
});
