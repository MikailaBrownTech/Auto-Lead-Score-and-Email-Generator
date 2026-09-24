import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client";
import { leads } from "../src/db/schema";
import { generateSequence } from "../src/write/generate";
import { validatePersonalLine } from "../src/write/personal-line";
import { verifiedValues } from "../src/write/values";
import { replay } from "./fixtures/replay";
import { evidence, offer, READY_OFFER, scripted, style, testWriteDeps } from "./fixtures/write-deps";

/**
 * Real personal-line generations, recorded with `npm run record-personal-lines` (one small-model call
 * per fixture lead, production request), replayed offline. Every recorded line must pass the code
 * checks and the assembled sequence the validators, on the first pass: no fallback, no error.
 */
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "generations");
const RECORDED = fs.readdirSync(DIR).filter((f) => f.endsWith(".json"));

describe("recorded personal-line generations (5 fixture leads)", { timeout: 60_000 }, () => {
  it("covers five fixture leads", () => {
    expect(RECORDED).toHaveLength(5);
  });

  it.each(RECORDED)("%s: the model's line passes on the first pass", async (file) => {
    const rec = JSON.parse(fs.readFileSync(path.join(DIR, file), "utf8")) as { fixture: string; tool_input: { personal_line: string; subject?: "A" | "B" } };
    const r = await replay(rec.fixture);
    const d = r.dossier;
    expect(validatePersonalLine(rec.tool_input.personal_line, { dossier: d, values: verifiedValues(d, offer, evidence).prospect_facts, style, evidence })).toEqual([]);

    const db = openDb(":memory:");
    db.insert(leads).values({ id: d.lead_id, source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();
    const { deps, create } = testWriteDeps(db, scripted([rec.tool_input]), { offer: READY_OFFER });
    // Tier B: one personal-line call (gate approved so out-of-ICP fixtures still write).
    const g = await generateSequence(d.lead_id, d, "B", deps, { gateApproved: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(g.personalLine).toMatchObject({ line: { source: "model", text: rec.tool_input.personal_line }, note: null, usedFallbackAfterAssembly: false });
    expect(g.validation!.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(g.status).toBe("passed");
  });
});
