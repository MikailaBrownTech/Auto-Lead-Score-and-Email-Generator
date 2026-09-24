/**
 * Live extraction check. Fetches real sites, runs extraction with the real API, and prints
 * everything needed to verify each fact by hand.
 *
 *   npm run extract-live -- <url> [<url> ...] [--refresh] [--record]
 *
 * Several URLs run as one batch: every site is fetched first, then the extractions run back to back
 * so the cached prompt prefix is written once and read by the rest.
 * --refresh  ignores the page, robots.txt, and extraction caches (fresh fetch, fresh model call).
 * --record   saves each site's pages, sitemap, robots.txt, DNS answers, and model tool calls to
 *            apps/server/test/fixtures/live/<site>/ for offline regression tests.
 *
 * Each lead's full report is written to data/reports/<lead>.txt; the console shows only the summary
 * block and the file paths.
 */
import fs from "node:fs";
import path from "node:path";
import { FACT_FIELDS, isFound } from "@clearpath/shared";
import { and, gt, inArray, max } from "drizzle-orm";
import { bootstrapOrExit } from "../src/bootstrap";
import { leadOverride } from "../src/scoring/direct-contact";
import { exitForLeads, installExitHandlers } from "./exit";
import { leadNotes } from "./lead-notes";
import { fromRoot } from "../src/config/paths";
import { runs } from "../src/db/schema";
import { loadMxProviders, systemDnsResolver } from "../src/dns/lookup";
import { loadEvidence, loadOffer, loadScoring } from "../src/docs/loader";
import { loadExtractionSystemPrompt } from "../src/extract/prompt";
import { loadInjectionPatterns } from "../src/extract/untrusted";
import { quoteInText } from "../src/extract/verify";
import { HostRateLimiter } from "../src/fetch/rate-limit";
import { Recorder } from "../src/fetch/recording";
import { loadSkipPatterns } from "../src/fetch/select";
import { userAgentFor } from "../src/fetch/site";
import { systemResolver, undiciTransport } from "../src/fetch/transport";
import { contactPlan } from "../src/scoring/contact";
import { completeLead, prepareWebLead, type PreparedLead, type ResearchDeps, type ResearchReport } from "../src/pipeline/research";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const record = args.includes("--record");
const urls = args.filter((a) => !a.startsWith("--"));
if (urls.length === 0) {
  console.error("usage: npm run extract-live -- <url> [<url> ...] [--refresh] [--record]");
  process.exit(2);
}

const recorder = record ? new Recorder() : null;
installExitHandlers();
const ctx = bootstrapOrExit(recorder ? { wrapApi: (api) => recorder.api(api) } : {});
const scoring = loadScoring();
const offer = loadOffer();
const deps: ResearchDeps = {
  db: ctx.db,
  llm: ctx.llm,
  modelExtract: ctx.env.MODEL_EXTRACT,
  systemPrompt: loadExtractionSystemPrompt(),
  caps: { perPage: ctx.env.MAX_TOKENS_PER_PAGE, perLead: ctx.env.MAX_INPUT_TOKENS_PER_LEAD },
  fetch: {
    resolver: recorder ? recorder.resolver(systemResolver) : systemResolver,
    transport: recorder ? recorder.transport(undiciTransport) : undiciTransport,
    userAgent: userAgentFor(ctx.env.CONTACT_URL),
    timeoutMs: ctx.env.FETCH_TIMEOUT_MS,
    maxBytes: ctx.env.FETCH_MAX_BYTES,
    skipPatterns: loadSkipPatterns(),
    limiter: new HostRateLimiter(1000),
  },
  dns: recorder ? recorder.dnsResolver(systemDnsResolver) : systemDnsResolver,
  mxProviders: loadMxProviders(),
  pageCacheDays: ctx.env.PAGE_CACHE_DAYS,
  injectionPatterns: loadInjectionPatterns(),
  scoring,
  evidence: loadEvidence(),
  now: () => new Date(),
  refresh,
  allowWithoutDirectContact: offer.allow_without_direct_contact,
};

/** Report lines go to the current buffer (a lead's report file, or the run summary). */
let buffer: string[] = [];
const log = (...parts: unknown[]) => buffer.push(parts.map(String).join(" "));
const REPORTS_DIR = fromRoot("data/reports");

const RULE = "=".repeat(100);
const THIN = "-".repeat(100);
const short = (h: string) => `${h.slice(0, 12)}…`;
const q = (s: unknown) => JSON.stringify(s);
const usd = (n: number) => `$${n.toFixed(6)}`;

function siteName(url: string): string {
  const host = url.replace(/^[a-z]+:\/\//i, "").split("/")[0]!.toLowerCase().replace(/^www\./, "");
  return host.replace(/[^a-z0-9]+/g, "-");
}

function printEvidence(url: string, quote: string, texts: Map<string, string>, indent = "      ") {
  const full = texts.get(url);
  const found = url === "pasted" ? "n/a" : full === undefined ? "page not found" : quoteInText(full, quote) ? "yes" : "NO";
  log(`${indent}url   : ${url}`);
  log(`${indent}quote : ${q(quote)}   (found in cleaned text: ${found})`);
}

function report(r: ResearchReport, firstRunId: number) {
  const d = r.dossier;
  const texts = new Map(r.pages.map((p) => [p.url, p.text]));
  log(RULE);
  log(`LEAD ${r.leadId}   ${d.url}`);
  log(`status: ${r.status}${r.error ? `   error: ${r.error}` : ""}`);
  if (d.declined_automated_access) log("ACCESS: the site declined automated access (HTTP 403/429). PASTE-TEXT PROMPT: paste the About/Team/Contact page text to research this lead.");
  log(`GATE: ${d.gate.status.toUpperCase()}${d.gate.reasons.length ? `   (${d.gate.reasons.join("; ")})` : ""}`);
  log(`score: ${r.score.total} (tier ${r.score.tier}${r.score.tierCapped ? `, capped at C: fit ${r.score.fitPoints} < ${scoring.fit_threshold}` : ""})   fit points ${r.score.fitPoints}`);
  for (const line of leadNotes(d, r.score, offer, leadOverride(ctx.db, r.leadId))) log(line);

  log(THIN);
  log("INTERNAL LINKS DISCOVERED ON THE HOMEPAGE (decision -> fetch result)");
  if (r.links.length === 0) log("  (none)");
  for (const l of r.links) log(`  ${l.kind.padEnd(9)} ${l.url}   [${l.decision}${l.fetch ? ` -> ${l.fetch}` : ""}]`);

  log(THIN);
  log("PAGES FETCHED (pages_opened: HTTP 200 text/html only)");
  if (r.pages.length === 0) log("  (none)");
  for (const p of r.pages) {
    const flags = [p.fromCache ? "cached" : "fetched", p.truncated ? "TRUNCATED" : "", p.nearEmpty ? "NEAR-EMPTY" : ""].filter(Boolean).join(", ");
    log(`  ${p.kind.padEnd(9)} ${p.url}`);
    log(`            title ${q(p.title)}   ${p.text.length} chars   text sha256 ${short(p.textSha256)}   raw sha256 ${short(p.rawSha256)}   [${flags}]`);
    if (p.dates.length) log(`            dates: ${p.dates.map((x) => `${x.date} (${x.source})`).join(", ")}`);
  }
  log(`  sitemap: ${r.sitemap ? `${r.sitemap.url}, ${r.sitemap.entries.length} entries with lastmod${r.sitemap.fromCache ? " (cached)" : ""}` : "none"}`);

  log(THIN);
  log("SENT TO THE MODEL (after token caps)");
  if (r.sent.length === 0) log("  (nothing sent)");
  for (const s of r.sent) log(`  ${String(s.kind).padEnd(9)} ${s.url}   ${s.tokens} tokens${s.truncated ? "   [cut]" : ""}`);

  log(THIN);
  log("FAILURES AND NOTES");
  if (d.failures.length === 0) log("  (none)");
  for (const f of d.failures) log(`  - ${f}`);

  log(THIN);
  log(`PROMPT INJECTION: ${d.prompt_injection_flag ? "FLAGGED" : "none found"}`);
  for (const f of d.injection_findings) log(`  - [${f.where}] ${f.url}: ${q(f.snippet)}`);

  log(THIN);
  log("DNS (code, not the model)");
  for (const [k, v] of Object.entries(d.dns)) {
    if (typeof v === "string") log(`  ${k.padEnd(16)} ${v}`);
    else log(`  ${k.padEnd(16)} ${q(v.value)}   ${v.evidence_url}   ${q(v.evidence_quote)}`);
  }

  const search = d.security_mention_search;
  const wisp = r.score.breakdown.find((b) => b.key === "no_wisp_mention")!;
  log(THIN);
  log("SECURITY KEYWORD SEARCH (code; runs on the FULL cleaned text of every page opened, not the token-capped text)");
  if (search === "NOT_CHECKED") log("  not checked");
  else {
    log(`  ${search.pages.length} pages, ${search.matches.length} matches   (no-WISP points ${wisp.points}/${wisp.max}: ${wisp.reason})`);
    for (const m of search.matches) log(`  - "${m.keyword}" on ${m.url}`);
  }

  log(THIN);
  log("CODE-DERIVED FIELDS");
  log(`  firm_name_candidates ${d.firm_name_candidates.length ? d.firm_name_candidates.map((h) => `${h.source}=${q(h.value)}`).join("  ") : "(none)"}`);
  log(`  public_email_kind   ${d.public_email_kind}`);
  log(`  decision_maker      ${isFound(d.decision_maker) ? `${q(d.decision_maker.value)}   (from people, by title preference)` : "NOT_FOUND"}`);
  if (isFound(d.decision_maker)) printEvidence(d.decision_maker.evidence_url, d.decision_maker.evidence_quote, texts);
  const plan = contactPlan(d);
  log(`  greeting            ${q(plan.greeting)}   contact_mismatch: ${plan.contactMismatch}   generic_inbox: ${plan.genericInbox}   (${plan.reason})`);
  log(`  us_location         ${q(d.us_location.value)}   (${d.us_location.reason})`);
  log(`  target_industry_fit ${q(d.target_industry_fit.value)}   (${d.target_industry_fit.reason})`);
  const fresh = d.latest_dated_content;
  log(`  latest_dated_content ${isFound(fresh) ? `${fresh.value.date} from ${fresh.value.source}   ${fresh.evidence_url}   ${q(fresh.evidence_quote)}` : "NOT_FOUND (no machine-readable date)"}`);

  log(THIN);
  log("MODEL FIELDS");
  let filled = 0;
  for (const field of FACT_FIELDS) {
    const fact = d[field] as unknown;
    const check = r.extraction?.fields[field];
    const retried = check?.retried ? " (retried)" : "";
    const empty = fact === "NOT_FOUND" || (Array.isArray(fact) && fact.length === 0);
    if (!empty) {
      filled++;
      log(`  ${field}   VERIFIED${retried}`);
      if (Array.isArray(fact)) {
        for (const item of fact as { evidence_url: string; evidence_quote: string }[]) {
          const { evidence_url, evidence_quote, ...rest } = item;
          log(`    - ${q(rest)}`);
          printEvidence(evidence_url, evidence_quote, texts, "        ");
        }
      } else if (typeof fact === "object" && fact !== null && "evidence" in fact) {
        const f = fact as { value: unknown; evidence: { item: string; evidence_url: string }[] };
        log(`      value : ${q(f.value)}`);
        for (const e of f.evidence) log(`      found : ${q(e.item)} on ${e.evidence_url}`);
      } else {
        const f = fact as { value: unknown; evidence_url: string; evidence_quote: string };
        log(`      value : ${q(f.value)}`);
        printEvidence(f.evidence_url, f.evidence_quote, texts);
      }
    } else if (check?.status === "rejected") {
      log(`  ${field}   NOT_FOUND (model answer rejected: ${check.kind}${retried})`);
      if (check.firstReason) log(`      first pass: ${check.firstReason}`);
      log(`      reason: ${check.reason}`);
      if (check.answer !== undefined) log(`      model answer: ${q(check.answer)}`);
    } else {
      log(`  ${field}   ${Array.isArray(fact) ? "none" : "NOT_FOUND"}`);
    }
  }

  log(THIN);
  log("SCORE BREAKDOWN");
  for (const b of r.score.breakdown) log(`  ${String(b.points).padStart(2)}/${String(b.max).padEnd(2)} ${b.group.padEnd(12)} ${b.key.padEnd(28)} ${b.reason}`);

  const rows = ctx.db.select().from(runs).where(and(inArray(runs.leadId, [r.leadId]), gt(runs.id, firstRunId))).all();
  const cost = rows.reduce((s, x) => s + x.costUsd, 0);
  return { filled, notFound: FACT_FIELDS.length - filled, retries: r.extraction?.retriesUsed ?? 0, cost, rows };
}

// Phase 1: fetch every site (no model calls).
const firstRunId = ctx.db.select({ id: max(runs.id) }).from(runs).get()?.id ?? 0;
const prepared: PreparedLead[] = [];
for (const url of urls) {
  const name = siteName(url);
  recorder?.start(name, url);
  console.error(`fetching ${url} ...`);
  prepared.push(await prepareWebLead(`live-${name}`, url, deps));
}

// Phase 2: extractions back to back, so the cached prefix written by the first is read by the rest.
const reports: ResearchReport[] = [];
for (const p of prepared) {
  recorder?.start(p.leadId.replace(/^live-/, ""), p.url);
  console.error(`extracting ${p.leadId} ...`);
  reports.push(await completeLead(p, deps));
}

const summaries: string[] = [];
const reportFiles: string[] = [];
fs.mkdirSync(REPORTS_DIR, { recursive: true });
for (const r of reports) {
  buffer = [];
  const s = report(r, firstRunId);
  const file = path.join(REPORTS_DIR, `${r.leadId.replace(/^live-/, "")}.txt`);
  fs.writeFileSync(file, buffer.join("\n") + "\n");
  reportFiles.push(file);
  summaries.push(
    `${r.leadId}: status ${r.status}, ${r.dossier.declined_automated_access ? "DECLINED AUTOMATED ACCESS (paste text needed), " : ""}${r.score.incompleteData.flag ? "INCOMPLETE DATA (paste mode recommended), " : ""}gate ${r.dossier.gate.status}, score ${r.score.total} tier ${r.score.tier}, ${s.filled}/${FACT_FIELDS.length} model fields filled, ${s.notFound} NOT_FOUND, retries used ${s.retries}, cost ${usd(s.cost)}${r.extraction?.fromCache ? " (cached extraction)" : ""}`,
  );
}

buffer = [];
log(RULE);
log(`WISP KEYWORDS (docs/06, ${scoring.wisp_keywords.length}): ${scoring.wisp_keywords.map((k) => q(k)).join(", ")}`);
log(RULE);
log("RUN COST SUMMARY (this command)");
const all = ctx.db.select().from(runs).where(gt(runs.id, firstRunId)).all();
const byType = new Map<string, { calls: number; input: number; output: number; read: number; write: number; cost: number }>();
for (const row of all) {
  const t = byType.get(row.callType) ?? { calls: 0, input: 0, output: 0, read: 0, write: 0, cost: 0 };
  t.calls++;
  t.input += row.inputTokens;
  t.output += row.outputTokens;
  t.read += row.cacheReadTokens;
  t.write += row.cacheWriteTokens;
  t.cost += row.costUsd;
  byType.set(row.callType, t);
}
log("  call type        calls   input  output  cache read  cache write        cost");
for (const [type, t] of byType) {
  log(`  ${type.padEnd(15)} ${String(t.calls).padStart(6)} ${String(t.input).padStart(7)} ${String(t.output).padStart(7)} ${String(t.read).padStart(11)} ${String(t.write).padStart(12)} ${usd(t.cost).padStart(11)}`);
}
for (const x of all.filter((y) => y.status === "error")) log(`  error: ${x.leadId} ${x.callType}: ${x.error}`);
const total = all.reduce((s, x) => s + x.costUsd, 0);
log(`  total ${usd(total)} for ${reports.length} lead(s)   month to date ${usd(ctx.gate.spentThisMonthUsd())} of $${ctx.gate.capUsd.toFixed(2)} cap`);
log(RULE);
log("SUMMARY");
for (const s of summaries) log(`  ${s}`);

if (recorder) {
  const dirs = recorder.save(fromRoot("apps/server/test/fixtures/live"));
  log(RULE);
  log("FIXTURES SAVED");
  for (const d of dirs) log(`  ${d}`);
}
log(RULE);
log("FULL REPORTS");
for (const f of reportFiles) log(`  ${f}`);
// Only the summary block reaches the console; the full per-lead reports are in the files above.
console.log(buffer.join("\n"));
exitForLeads(reports);
