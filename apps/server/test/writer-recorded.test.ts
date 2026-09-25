import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JUDGE_TOOL_NAME, WRITER_TOOL_NAME, type OfferConfig } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client";
import { leads } from "../src/db/schema";
import { findAbsenceClaims } from "../src/validators/email";
import { generateSequence } from "../src/write/generate";
import { replay } from "./fixtures/replay";
import { scripted, style, testWriteDeps } from "./fixtures/write-deps";

/**
 * Real writer and judge answers, recorded with `npm run record-sequences` for 5 fixture leads (real
 * MODEL_WRITE calls; see the .md files next to the recordings for the manual tone check), replayed
 * offline with the docs/01 settings they were recorded with. The final sequence of every lead must pass
 * the reduced validator set, with the same number of writer calls as recorded. The judge's verdict is
 * replayed as recorded and reported, not required: it is the second check a human reviews.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "generations");
const RECORDED = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));

interface Recording {
  fixture: string;
  lead_id: string;
  offer: OfferConfig;
  calls: { tool: string | null; input: unknown }[];
}

describe("recorded writer generations (5 fixture leads)", { timeout: 60_000 }, () => {
  it("covers five fixture leads", () => {
    expect(RECORDED).toHaveLength(5);
  });

  it.each(RECORDED)("%s: the final sequence passes the reduced validator set", async (file) => {
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as Recording;
    const d = { ...(await replay(rec.fixture)).dossier, lead_id: rec.lead_id };
    const writer = rec.calls.filter((c) => c.tool === WRITER_TOOL_NAME).map((c) => c.input);
    const judge = rec.calls.filter((c) => c.tool === JUDGE_TOOL_NAME).map((c) => c.input);
    const db = openDb(":memory:");
    db.insert(leads).values({ id: rec.lead_id, source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();
    const { deps } = testWriteDeps(db, scripted(writer, judge), { offer: rec.offer });
    const g = await generateSequence(rec.lead_id, d, "B", deps, { gateApproved: true });
    expect(g.writerCalls).toBe(writer.length);
    expect(g.validation!.issues.filter((i) => i.severity === "error")).toEqual([]);
    // Hard rule: the approved docs/02 sentence is in email 2, spliced in by code.
    expect(g.sequence!.emails[1]!.body).toMatch(/Publication 4557|insurers increasingly ask|The rule requires a written information security program/);
    expect(g.sequence!.emails.map((e) => e.body).join("\n")).not.toMatch(/\[\[|\]\]|hi there/i);
  });
});

describe("absence claims: the negation has to govern the plan term", () => {
  it.each([
    ["You don't have a written plan yet.", true],
    ["The firm is operating without a WISP.", true],
    ["I'll hand you a written plan and next steps, no cost.", false],
    ["A written plan can wait until after the season; no rush.", false],
  ])("%s -> %s", (sentence, flagged) => {
    expect(findAbsenceClaims(sentence, style).length > 0).toBe(flagged);
  });
});
