/**
 * npm run record-sequences [-- <fixture> ...] [--dry-run]
 *
 * Records real writer + judge answers for regression tests: each fixture lead is researched offline
 * from its recorded live site (no network, recorded extraction), then generateSequence runs with the
 * REAL model (MODEL_WRITE: one writer call, a rewrite only if the validators find errors, one judge
 * call; counts toward the monthly cap and is logged in runs under lead id record-<fixture>). Every
 * tool answer is saved in call order to apps/server/test/fixtures/generations/<fixture>.json and
 * replayed by test/writer-recorded.test.ts with the docs/01 settings saved alongside. A readable copy of the final sequence is written next to
 * it (<fixture>.md) for the manual tone check. --dry-run prints the writer's user message only.
 */
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { bootstrapOrExit } from "../src/bootstrap";
import { fromRoot } from "../src/config/paths";
import { loadApprovedSentences, loadEvidence, loadOffer, loadStyle, loadWriterFacts } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { and, eq, gt, sql } from "drizzle-orm";
import { leadEvents, runs, sequences } from "../src/db/schema";
import { lastRunId, type MessagesApi } from "../src/llm/client";
import { writerSystemFor } from "../src/server/services";
import { renderEmail } from "../src/validators/email";
import { firstNameFor, generateSequence, type WriteDeps } from "../src/write/generate";
import { renderSignature } from "../src/write/merge";
import { examplesFor, loadExampleSequences, loadJudgeSystemPrompt, loadPersonaHeadings, writerMessage } from "../src/write/prompt";
import { writerInput } from "../src/write/writer";
import { replay } from "../test/fixtures/replay";

/** The five fixture leads the regression test covers (qualified, different types and contacts). */
export const RECORDED_FIXTURES = ["innercircle-cpa", "rbvfinancial-com", "essentialacctg-com", "metaxparma-com", "mapaccountinggroup-com"];

const names = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
const calls: { tool: string | null; input: unknown; model: string; usage: Anthropic.Usage }[] = [];
const ctx = bootstrapOrExit({
  wrapApi: (api) =>
    ({
      messages: {
        countTokens: (p: Anthropic.MessageCountTokensParams) => api.messages.countTokens(p),
        create: async (p: Anthropic.MessageCreateParamsNonStreaming) => {
          const m = await api.messages.create(p);
          const block = m.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          calls.push({ tool: block?.name ?? null, input: block?.input ?? null, model: m.model, usage: m.usage });
          return m;
        },
      },
    }) as unknown as MessagesApi,
});
const offer = loadOffer();
const style = loadStyle();
const facts = loadWriterFacts();
const outDir = fromRoot("apps/server/test/fixtures/generations");
fs.mkdirSync(outDir, { recursive: true });

let total = 0;
for (const name of names.length ? names : RECORDED_FIXTURES) {
  const r = await replay(name);
  const d = r.dossier;
  const leadId = `record-${name}`;
  // The real DB, so the per-lead token budget counts only this run; the sequence and event rows written
  // for record-<fixture> are deleted afterwards (nothing appears in the app). Runs and cost stay logged.
  const deps: WriteDeps = {
    db: ctx.db,
    llm: ctx.llm,
    modelWrite: ctx.env.MODEL_WRITE,
    writerSystem: writerSystemFor({ offer, facts, style }),
    judgeSystem: loadJudgeSystemPrompt({ offer, facts }),
    style,
    offer,
    evidence: loadEvidence(),
    templates: loadTemplates(),
    facts,
    approved: loadApprovedSentences().sentences,
    personas: loadPersonaHeadings(),
  };
  if (dryRun) {
    console.log(`--- ${name} (examples ${examplesFor(leadId, loadExampleSequences()).join(", ")})\n${writerMessage(writerInput(d, deps, firstNameFor(d, null)))}\n`);
    continue;
  }
  calls.length = 0;
  // Tiers A and B both get all five emails from the writer; the gate is approved so any fixture writes.
  const before = lastRunId(ctx.db);
  const g = await generateSequence(leadId, d, "B", deps, { gateApproved: true });
  const cost = ctx.db.select({ c: sql<number>`coalesce(sum(${runs.costUsd}), 0)` }).from(runs).where(and(eq(runs.leadId, leadId), gt(runs.id, before))).get()!;
  total += cost.c;
  ctx.db.delete(sequences).where(eq(sequences.leadId, leadId)).run();
  ctx.db.delete(leadEvents).where(eq(leadEvents.leadId, leadId)).run();
  fs.writeFileSync(
    path.join(outDir, `${name}.json`),
    JSON.stringify({ fixture: name, lead_id: leadId, captured_at: new Date().toISOString(), offer, calls, result: { status: g.status, firstPassValid: g.firstPassValid, writerCalls: g.writerCalls, judge: g.judge, cost_usd: cost.c } }, null, 2) + "\n",
  );
  const signature = renderSignature(deps.templates.signature, offer);
  const md = [
    `# ${name}: recorded sequence (manual tone check)`,
    "",
    `status ${g.status}; first pass ${g.firstPassValid ? "valid" : "invalid"}; writer calls ${g.writerCalls}; judge ${g.judge?.unsupported_claims.length ? `${g.judge.unsupported_claims.length} claim(s)` : "clean"}`,
    "",
    ...(g.sequence?.emails ?? []).flatMap((e) => [`## Email ${e.n} (day ${e.send_day})`, "", ...(e.subject_a ? [`Subject${e.subject_b ? " A" : ""}: ${e.subject_a}`] : []), ...(e.subject_b ? [`Subject B: ${e.subject_b}`] : []), "", "```text", renderEmail(e.body, offer, signature), "```", ""]),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, `${name}.md`), md);
  console.log(`${name}: ${g.status}, first pass ${g.firstPassValid ? "VALID" : "invalid"}, writer calls ${g.writerCalls}, judge ${g.judge?.unsupported_claims.length ?? "n/a"} claim(s)`);
  for (const dr of g.drafts) for (const i of dr.errors) console.log(`   draft ${dr.attempt}: email ${i.email ?? "-"} ${i.code}: ${i.message}`);
}
console.log(`month to date $${ctx.gate.spentThisMonthUsd().toFixed(4)} of $${ctx.gate.capUsd.toFixed(2)} (this run about $${total.toFixed(4)})`);
