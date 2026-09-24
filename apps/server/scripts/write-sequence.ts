/**
 * Research leads and generate their sequences (template-first: docs/09 copy + one personal line), with the real API.
 *
 *   npm run write-sequence -- <url> [<url> ...] [--refresh]
 *
 * Research reuses the page, robots.txt, and extraction caches (--refresh ignores them). Sequences
 * follow tier and gate: tiers A and B make one small call for {{personal_line}}; Tier C and gated leads
 * make none. Report mode: the personal line (model or fallback, and why), the final sequence as sent,
 * the validator log, the blockers, tokens, and cost go to data/reports/<lead>-sequence.txt. The console
 * prints one summary line per lead and the file paths.
 */
import fs from "node:fs";
import path from "node:path";
import { isFound } from "@clearpath/shared";
import { and, eq, gt } from "drizzle-orm";
import { bootstrapOrExit } from "../src/bootstrap";
import { leadOverride } from "../src/scoring/direct-contact";
import { exitForLeads, installExitHandlers } from "./exit";
import { leadNotes } from "./lead-notes";
import { fromRoot } from "../src/config/paths";
import { leads, runs, type LeadStatus } from "../src/db/schema";
import { loadMxProviders, systemDnsResolver } from "../src/dns/lookup";
import { loadApprovedSentences, loadEvidence, loadOffer, loadScoring, loadStyle, loadWriterFacts } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { loadExtractionSystemPrompt } from "../src/extract/prompt";
import { loadInjectionPatterns } from "../src/extract/untrusted";
import { HostRateLimiter } from "../src/fetch/rate-limit";
import { loadSkipPatterns } from "../src/fetch/select";
import { userAgentFor } from "../src/fetch/site";
import { systemResolver, undiciTransport } from "../src/fetch/transport";
import { lastRunId } from "../src/llm/client";
import { researchWebLead, type ResearchDeps } from "../src/pipeline/research";
import { contactPlan } from "../src/scoring/contact";
import { renderEmail } from "../src/validators/email";
import { firstNameFor, generateSequence, type GenerateResult, type WriteDeps } from "../src/write/generate";
import { renderSettings, renderSignature } from "../src/write/merge";
import { loadJudgeSystemPrompt, loadPersonalLineSystemPrompt } from "../src/write/prompt";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const urls = args.filter((a) => !a.startsWith("--"));
if (urls.length === 0) {
  console.error("usage: npm run write-sequence -- <url> [<url> ...] [--refresh]");
  process.exit(2);
}

installExitHandlers();
const ctx = bootstrapOrExit();
const offer = loadOffer();
const facts = loadWriterFacts();
const evidence = loadEvidence();
const approved = loadApprovedSentences();
const research: ResearchDeps = {
  db: ctx.db,
  llm: ctx.llm,
  modelExtract: ctx.env.MODEL_EXTRACT,
  systemPrompt: loadExtractionSystemPrompt(),
  caps: { perPage: ctx.env.MAX_TOKENS_PER_PAGE, perLead: ctx.env.MAX_INPUT_TOKENS_PER_LEAD },
  fetch: {
    resolver: systemResolver,
    transport: undiciTransport,
    userAgent: userAgentFor(ctx.env.CONTACT_URL),
    timeoutMs: ctx.env.FETCH_TIMEOUT_MS,
    maxBytes: ctx.env.FETCH_MAX_BYTES,
    skipPatterns: loadSkipPatterns(),
    limiter: new HostRateLimiter(1000),
  },
  dns: systemDnsResolver,
  mxProviders: loadMxProviders(),
  pageCacheDays: ctx.env.PAGE_CACHE_DAYS,
  injectionPatterns: loadInjectionPatterns(),
  scoring: loadScoring(),
  evidence,
  now: () => new Date(),
  refresh,
};
const style = loadStyle();
const writeDeps: WriteDeps = {
  db: ctx.db,
  llm: ctx.llm,
  modelLine: ctx.env.MODEL_EXTRACT,
  lineSystem: loadPersonalLineSystemPrompt(style),
  modelJudge: ctx.env.MODEL_WRITE,
  judgeSystem: loadJudgeSystemPrompt({ offer, facts }),
  style,
  offer,
  evidence,
  templates: loadTemplates(),
  facts,
  approved: approved.sentences,
};
const signature = renderSignature(writeDeps.templates.signature, offer);

const RULE = "=".repeat(90);
const THIN = "-".repeat(90);
const usd = (n: number) => `$${n.toFixed(6)}`;
const summaries: string[] = [];
const results: { leadId: string; status: LeadStatus; error: string | null }[] = [];
const files: string[] = [];

for (const url of urls) {
  const site = url.replace(/^[a-z]+:\/\//i, "").split("/")[0]!.toLowerCase().replace(/^www\./, "").replace(/[^a-z0-9]+/g, "-");
  const leadId = `live-${site}`;
  const firstRunId = lastRunId(ctx.db);
  console.error(`researching ${url} ...`);
  const r = await researchWebLead(leadId, url, research);
  const gateApproved = ctx.db.select({ v: leads.gateApproved }).from(leads).where(eq(leads.id, leadId)).get()?.v ?? false;
  console.error(`generating sequence for ${leadId} (tier ${r.score.tier}, gate ${r.dossier.gate.status}) ...`);
  const override = leadOverride(ctx.db, leadId);
  const g = await generateSequence(leadId, r.dossier, r.score.tier, writeDeps, { gateApproved, directContactOverride: override });
  results.push({ leadId, status: r.status, error: r.error });

  const out: string[] = [];
  const log = (s = "") => out.push(s);
  const d = r.dossier;
  const plan = contactPlan(d);
  log(RULE);
  log(`LEAD ${leadId}   ${d.url}`);
  log(`firm: ${isFound(d.firm_name) ? d.firm_name.value : "NOT_FOUND"}   type: ${isFound(d.firm_type) ? `${d.firm_type.value.primary}${d.firm_type.value.secondary.length ? ` (+${d.firm_type.value.secondary.join(", ")})` : ""}` : "NOT_FOUND"}`);
  log(`gate: ${d.gate.status}${d.gate.reasons.length ? ` (${d.gate.reasons.join("; ")})` : ""}${gateApproved ? "   [gate approved by founder]" : ""}`);
  log(`score: ${r.score.total}   tier: ${r.score.tier}${r.score.tierCapped ? " (capped at C by fit)" : ""}   lead status: ${r.status}`);
  if (d.declined_automated_access) log("ACCESS: the site declined automated access (HTTP 403/429). PASTE-TEXT PROMPT: paste the About/Team/Contact page text to research this lead fully.");
  for (const line of leadNotes(d, r.score, offer, override)) log(line);
  const first = firstNameFor(d, override);
  log(`email 1 opens with: ${first ? `"Hi ${first},"` : "the docs/09 role-based line"}${override ? " (contact override)" : ""}   contact_mismatch: ${plan.contactMismatch}   generic_inbox: ${plan.genericInbox}   (${plan.reason})`);
  if (approved.excluded.length) log(`docs/02 approved sentences excluded: ${approved.excluded.map((x) => `${x.id} (${x.reason})`).join("; ")}`);

  log(RULE);
  const pl = g.personalLine;
  if (pl) {
    log(`PERSONAL LINE [${pl.line.source === "model" ? "model" : "docs/09 fallback"}]: ${pl.line.text}`);
    if (pl.note) log(`  why the fallback: ${pl.note}`);
    if (pl.rejected) log(`  model's rejected line: ${pl.rejected}`);
    if (pl.subject) log(`  model's subject pick: ${pl.subject}`);
  }

  log(RULE);
  log(`FINAL SEQUENCE: ${g.status.toUpperCase()}   (${g.reason})`);
  if (g.sequence) {
    for (const e of g.sequence.emails) {
      log(THIN);
      log(`EMAIL ${e.n}   day ${e.send_day}   docs/09${e.personal_line ? ` + personal line (${e.personal_line.source})` : ""}   grounding: [${e.grounding.join(", ")}]`);
      if (e.subject_a) log(`subject${e.n === 1 ? " A" : " (new thread)"}: ${renderSettings(e.subject_a, offer)}`);
      if (e.subject_b) log(`subject B: ${renderSettings(e.subject_b, offer)}`);
      log("");
      log(renderEmail(e.body, offer, signature));
    }
  }
  log(RULE);
  log("VALIDATOR LOG (final sequence)");
  if (!g.validation) log("  (not run)");
  else if (g.validation.issues.length === 0) log("  PASS, no issues");
  else for (const i of g.validation.issues) log(`  ${i.severity.toUpperCase()} ${i.email ? `email ${i.email}` : "sequence"} ${i.code}: ${i.message}`);
  log(`APPROVAL: ${g.status !== "passed" ? "BLOCKED (docs/09 copy or settings)" : `allowed (sequence id ${g.sequenceId})`}${g.contactWarning ? `   contact warning: ${g.contactWarning}` : ""}`);
  log(`EXPORT: ${g.exportBlockers.length ? `BLOCKED: ${g.exportBlockers.join("; ")}` : "allowed"}`);

  log(RULE);
  log("TOKENS AND COST (this command, this lead)");
  const rows = ctx.db.select().from(runs).where(and(eq(runs.leadId, leadId), gt(runs.id, firstRunId))).all();
  log("  call type        model                        input  output  cache read  cache write        cost");
  for (const x of rows) {
    log(`  ${x.callType.padEnd(15)} ${x.model.padEnd(26)} ${String(x.inputTokens).padStart(7)} ${String(x.outputTokens).padStart(7)} ${String(x.cacheReadTokens).padStart(11)} ${String(x.cacheWriteTokens).padStart(12)} ${usd(x.costUsd).padStart(11)}${x.status === "error" ? `  ERROR ${x.error}` : ""}`);
  }
  if (rows.length === 0) log("  (no API calls)");
  const cost = rows.reduce((s, x) => s + x.costUsd, 0);
  log(`  lead total ${usd(cost)}`);

  const dir = fromRoot("data/reports");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${site}-sequence.txt`);
  fs.writeFileSync(file, out.join("\n") + "\n");
  files.push(file);
  summaries.push(`${summaryLine(leadId, r.score.tier, g, cost)}; lead status ${r.status}${r.score.incompleteData.flag ? ", INCOMPLETE DATA" : ""}`);
}

function summaryLine(leadId: string, tier: string, g: GenerateResult, cost: number): string {
  const line = !g.personalLine ? "no personal line (not written)" : g.personalLine.line.source === "model" ? "personal line by the model" : `fallback line (${g.personalLine.called ? "model line rejected or call failed" : "no model call"})`;
  return `${leadId}: tier ${tier}, ${line}, model calls ${g.modelCalls}, final ${g.status}${g.contactWarning ? ` (warning: ${g.contactWarning})` : ""}, cost ${usd(cost)}`;
}

console.log(RULE);
console.log("SUMMARY");
for (const s of summaries) console.log(`  ${s}`);
console.log(`  month to date ${usd(ctx.gate.spentThisMonthUsd())} of $${ctx.gate.capUsd.toFixed(2)} cap`);
for (const f of files) console.log(`  report: ${f}`);
exitForLeads(results);
