/**
 * npm run record-personal-lines [-- <fixture> ...] [--dry-run]
 *
 * Records real {{personal_line}} generations for regression tests: each fixture lead is researched
 * offline from its recorded live site (no network, recorded extraction), then ONE real personal-line
 * call is made with the production request (small model, counts toward the monthly cap, logged in
 * runs). The raw tool input is saved to apps/server/test/fixtures/generations/<fixture>.json and is
 * replayed by test/personal-line-recorded.test.ts. Nothing is validated or repaired here: the test
 * decides whether the recorded line passes. --dry-run prints each request and makes no call.
 */
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { PERSONAL_LINE_TOOL_NAME } from "@clearpath/shared";
import { bootstrapOrExit } from "../src/bootstrap";
import { fromRoot } from "../src/config/paths";
import { loadEvidence, loadOffer, loadStyle } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { lastRunId } from "../src/llm/client";
import { firstNameFor } from "../src/write/generate";
import { lineRequest, personalLineParams } from "../src/write/personal-line";
import { loadPersonalLineSystemPrompt, personalLineMessage } from "../src/write/prompt";
import { replay } from "../test/fixtures/replay";

/** The five fixture leads the regression test covers (qualified, different types and contacts). */
export const RECORDED_FIXTURES = ["innercircle-cpa", "rbvfinancial-com", "essentialacctg-com", "metaxparma-com", "mapaccountinggroup-com"];

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const ctx = bootstrapOrExit();
const style = loadStyle();
const deps = { modelLine: ctx.env.MODEL_EXTRACT, lineSystem: loadPersonalLineSystemPrompt(style) };
const outDir = fromRoot("apps/server/test/fixtures/generations");
fs.mkdirSync(outDir, { recursive: true });

let total = 0;
for (const name of names.length ? names : RECORDED_FIXTURES) {
  const r = await replay(name);
  const req = lineRequest(r.dossier, { offer: loadOffer(), evidence: loadEvidence(), templates: loadTemplates() }, firstNameFor(r.dossier, null));
  if (dryRun) {
    console.log(`--- ${name}\n${personalLineMessage(req)}\n`);
    continue;
  }
  const { message, costUsd } = await ctx.llm.call(
    { callType: "personal_line", leadId: `record-${name}`, budgetSinceRunId: lastRunId(ctx.db) },
    personalLineParams(deps, personalLineMessage(req)),
  );
  const block = message.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === PERSONAL_LINE_TOOL_NAME);
  const record = {
    fixture: name,
    model: message.model,
    captured_at: new Date().toISOString(),
    request: req,
    tool_input: block?.input ?? null,
    usage: message.usage,
    cost_usd: costUsd,
  };
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
  total += costUsd;
  console.log(`${name}: ${JSON.stringify(block?.input ?? null)}  ($${costUsd.toFixed(6)})`);
}
console.log(`total $${total.toFixed(6)}; month to date $${ctx.gate.spentThisMonthUsd().toFixed(4)} of $${ctx.gate.capUsd.toFixed(2)}`);
