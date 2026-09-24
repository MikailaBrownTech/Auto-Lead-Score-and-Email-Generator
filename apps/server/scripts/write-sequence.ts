/**
 * Research leads and generate their sequences (Milestone 4), with the real API.
 *
 *   npm run write-sequence -- <url> [<url> ...] [--refresh]
 *
 * Research reuses the page, robots.txt, and extraction caches (--refresh ignores them). Sequences
 * follow tier and gate: Tier C and gated leads make no writer or judge calls.
 * Report mode: every writer draft (blocked ones included) with its validator errors, the code-inserted
 * approved sentences shown apart from the model's words, the final sequence, the judge result, the
 * blockers, tokens, and cost go to data/reports/<lead>-sequence.txt. The console prints one summary
 * line per lead and the file paths.
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
import { contactPlan, leadGreeting, neutralGreeting } from "../src/scoring/contact";
import { renderEmail } from "../src/validators/email";
import { generateSequence, type GenerateResult } from "../src/write/generate";
import { loadJudgeSystemPrompt, loadPersonaHeadings, loadWriterSystemPrompt } from "../src/write/prompt";

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
const writeDeps = {
  db: ctx.db,
  llm: ctx.llm,
  modelWrite: ctx.env.MODEL_WRITE,
  writerSystem: loadWriterSystemPrompt({ offer, facts }),
  judgeSystem: loadJudgeSystemPrompt({ offer, facts }),
  style: loadStyle(),
  offer,
  evidence,
  templates: loadTemplates(),
  facts,
  approved: approved.sentences,
  personas: loadPersonaHeadings(),
};

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
  const plan = contactPlan(d, neutralGreeting(offer.neutral_greeting_style, d));
  log(RULE);
  log(`LEAD ${leadId}   ${d.url}`);
  log(`firm: ${isFound(d.firm_name) ? d.firm_name.value : "NOT_FOUND"}   type: ${isFound(d.firm_type) ? `${d.firm_type.value.primary}${d.firm_type.value.secondary.length ? ` (+${d.firm_type.value.secondary.join(", ")})` : ""}` : "NOT_FOUND"}`);
  log(`gate: ${d.gate.status}${d.gate.reasons.length ? ` (${d.gate.reasons.join("; ")})` : ""}${gateApproved ? "   [gate approved by founder]" : ""}`);
  log(`score: ${r.score.total}   tier: ${r.score.tier}${r.score.tierCapped ? " (capped at C by fit)" : ""}   lead status: ${r.status}`);
  if (d.declined_automated_access) log("ACCESS: the site declined automated access (HTTP 403/429). PASTE-TEXT PROMPT: paste the About/Team/Contact page text to research this lead fully.");
  for (const line of leadNotes(d, r.score, offer, override)) log(line);
  log(`greeting: ${JSON.stringify(leadGreeting(d, offer, override !== null))}${override ? " (contact override)" : ""}   contact_mismatch: ${plan.contactMismatch}   generic_inbox: ${plan.genericInbox}   (${plan.reason})`);
  if (approved.excluded.length) log(`docs/02 approved sentences excluded: ${approved.excluded.map((x) => `${x.id} (${x.reason})`).join("; ")}`);

  if (g.plan && g.plan.emails.length > 0) {
    log(RULE);
    log("WRITER INPUT (code-chosen; the only prospect facts the writer sees)");
    log(`  context: ${JSON.stringify({ firm_name: g.plan.context.firm_name, firm_type: g.plan.context.firm_type, location: g.plan.context.location })}`);
    log(`  persona: ${g.plan.context.persona}   angle: ${g.plan.context.angle}`);
    for (const e of g.plan.emails) {
      log(`  email ${e.n}: detail ${e.detail ? `${e.detail.field} = ${JSON.stringify(e.detail.value)}` : "none"}; slot ${e.approved ? e.approved.id : "none"}; model words ${e.modelWords ?? "2-3 sentences"}`);
    }
    if (g.plan.filtered.length) log(`  personal-detail filter removed: ${g.plan.filtered.join("; ")}`);
  }

  for (const draft of g.drafts) {
    log(RULE);
    log(`DRAFT ${draft.attempt} (${draft.attempt === 1 ? "first pass" : "rewrite"}): ${draft.formatProblem ? `UNUSABLE: ${draft.formatProblem}` : draft.errors.length === 0 ? "valid" : `${draft.errors.length} validator error(s)`}`);
    for (const e of draft.emails) {
      log(THIN);
      log(`email ${e.n}`);
      if (e.subject_a) log(`  subject A [model]: ${e.subject_a}\n  subject B [model]: ${e.subject_b}`);
      log(`  [model]    ${e.opening}`);
      for (const i of e.inserted) log(`  [APPROVED ${i.id}, inserted by code] ${i.text}`);
      if (e.closing) log(`  [model]    ${e.closing}`);
    }
    for (const i of draft.errors) log(`  ERROR ${i.email ? `email ${i.email}` : "sequence"} ${i.code}: ${i.message}`);
  }

  log(RULE);
  log(`FINAL SEQUENCE: ${g.status.toUpperCase()}   (${g.reason})`);
  if (g.sequence) {
    log(`persona: ${g.sequence.persona}   angle: ${g.sequence.angle}`);
    for (const e of g.sequence.emails) {
      log(THIN);
      log(`EMAIL ${e.n}   day ${e.send_day}   ${e.template ? "TEMPLATE (docs/09)" : "CUSTOM (writer + approved sentence)"}   grounding: [${e.grounding.join(", ")}]`);
      if (e.subject_a) log(`subject A: ${e.subject_a}\nsubject B: ${e.subject_b}`);
      log("");
      log(renderEmail(e.body, offer));
    }
  }
  log(RULE);
  log("VALIDATOR LOG (final sequence)");
  if (!g.validation) log("  (not run)");
  else if (g.validation.issues.length === 0) log("  PASS, no issues");
  else for (const i of g.validation.issues) log(`  ${i.severity.toUpperCase()} ${i.email ? `email ${i.email}` : "sequence"} ${i.code}: ${i.message}`);
  log("JUDGE");
  if (!g.judge) log(`  not run (${g.writerCalls === 0 ? "no custom emails" : "writer output unusable"})`);
  else if (g.judge.unsupported_claims.length === 0) log("  PASS: no unsupported claims");
  else for (const c of g.judge.unsupported_claims) log(`  email ${c.email} ${c.reason}: ${JSON.stringify(c.claim)}`);
  log(`APPROVAL: ${g.status !== "passed" ? "BLOCKED (content)" : `allowed (sequence id ${g.sequenceId})`}${g.contactWarning ? `   contact warning: ${g.contactWarning}` : ""}`);
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
  const first = g.firstPassValid === null ? "first pass n/a (no writer call)" : g.firstPassValid ? "first pass VALID" : "first pass invalid";
  const approval = g.status !== "passed" ? "blocked" : g.contactWarning ? `approvable; warning: ${g.contactWarning}` : "approvable";
  return `${leadId}: tier ${tier}, ${first}, rewrites used ${g.rewritesUsed}, final ${g.status} (${approval}), cost ${usd(cost)}`;
}

console.log(RULE);
console.log("SUMMARY");
for (const s of summaries) console.log(`  ${s}`);
console.log(`  month to date ${usd(ctx.gate.spentThisMonthUsd())} of $${ctx.gate.capUsd.toFixed(2)} cap`);
for (const f of files) console.log(`  report: ${f}`);
exitForLeads(results);
