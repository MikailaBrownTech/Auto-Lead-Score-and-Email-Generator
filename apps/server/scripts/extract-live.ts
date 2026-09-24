/**
 * Live extraction check (Milestone 3). Fetches real sites, runs extraction with the real API, and
 * prints everything needed to verify each fact by hand.
 *
 *   npm run extract-live -- <url> [<url> ...] [--refresh]
 *
 * --refresh ignores the page, robots.txt, and extraction caches (fresh fetch, fresh model call).
 * Spend is capped by MONTHLY_SPEND_CAP_USD and the per-lead token budget, like every other call.
 */
import { FACT_FIELDS, isFound } from "@clearpath/shared";
import { and, eq, gt, max } from "drizzle-orm";
import { bootstrapOrExit } from "../src/bootstrap";
import { runs } from "../src/db/schema";
import { loadMxProviders, systemDnsResolver } from "../src/dns/lookup";
import { loadScoring } from "../src/docs/loader";
import { loadExtractionSystemPrompt } from "../src/extract/prompt";
import { loadInjectionPatterns } from "../src/extract/untrusted";
import { quoteInText } from "../src/extract/verify";
import { HostRateLimiter } from "../src/fetch/rate-limit";
import { loadSkipPatterns } from "../src/fetch/select";
import { userAgentFor } from "../src/fetch/site";
import { systemResolver, undiciTransport } from "../src/fetch/transport";
import { researchWebLead, type ResearchDeps, type ResearchReport } from "../src/pipeline/research";

const args = process.argv.slice(2);
const refresh = args.includes("--refresh");
const urls = args.filter((a) => !a.startsWith("--"));
if (urls.length === 0) {
  console.error("usage: npm run extract-live -- <url> [<url> ...] [--refresh]");
  process.exit(2);
}

const ctx = bootstrapOrExit();
const deps: ResearchDeps = {
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
  now: () => new Date(),
  refresh,
};

const RULE = "=".repeat(100);
const THIN = "-".repeat(100);
const short = (h: string) => `${h.slice(0, 12)}…`;
const q = (s: unknown) => JSON.stringify(s);
const usd = (n: number) => `$${n.toFixed(6)}`;

function leadIdFor(url: string): string {
  const host = url.replace(/^[a-z]+:\/\//i, "").split("/")[0]!.toLowerCase().replace(/^www\./, "");
  return `live-${host.replace(/[^a-z0-9]+/g, "-")}`;
}

function report(r: ResearchReport, firstRunId: number): { filled: number; notFound: number; retries: number; cost: number } {
  const d = r.dossier;
  console.log(RULE);
  console.log(`LEAD ${r.leadId}   ${d.url}`);
  console.log(`status: ${r.status}${r.error ? `   error: ${r.error}` : ""}   score: ${r.score.total} (tier ${r.score.tier})`);

  console.log(THIN);
  console.log("PAGES FETCHED (pages_opened: HTTP 200 text/html only)");
  if (r.pages.length === 0) console.log("  (none)");
  for (const p of r.pages) {
    const flags = [p.fromCache ? "cached" : "fetched", p.truncated ? "TRUNCATED" : "", p.nearEmpty ? "NEAR-EMPTY" : ""].filter(Boolean).join(", ");
    console.log(`  ${p.kind.padEnd(9)} ${p.url}`);
    console.log(`            ${p.text.length} chars   text sha256 ${short(p.textSha256)}   raw sha256 ${short(p.rawSha256)}   fetched ${p.fetchedAt}   [${flags}]`);
  }

  console.log(THIN);
  console.log("SENT TO THE MODEL (after token caps)");
  if (r.sent.length === 0) console.log("  (nothing sent)");
  for (const s of r.sent) console.log(`  ${String(s.kind).padEnd(9)} ${s.url}   ${s.tokens} tokens${s.truncated ? "   [cut]" : ""}`);

  console.log(THIN);
  console.log("FAILURES");
  if (d.failures.length === 0) console.log("  (none)");
  for (const f of d.failures) console.log(`  - ${f}`);

  console.log(THIN);
  console.log(`PROMPT INJECTION: ${d.prompt_injection_flag ? "FLAGGED" : "none found"}`);
  for (const f of d.injection_findings) console.log(`  - [${f.where}] ${f.url}: ${q(f.snippet)}`);

  console.log(THIN);
  console.log("DNS (code, not the model)");
  for (const [k, v] of Object.entries(d.dns)) {
    if (typeof v === "string") console.log(`  ${k.padEnd(14)} ${v}`);
    else console.log(`  ${k.padEnd(14)} ${q(v.value)}   ${v.evidence_url}   ${q(v.evidence_quote)}`);
  }

  const search = d.security_mention_search;
  const wisp = r.score.breakdown.find((b) => b.key === "no_wisp_mention")!;
  console.log(THIN);
  if (search === "NOT_CHECKED") console.log("SECURITY KEYWORD SEARCH: not checked");
  else {
    console.log(`SECURITY KEYWORD SEARCH: ${search.pages.length} pages, ${search.keywords.length} keywords, ${search.matches.length} matches   (no-WISP points ${wisp.points}/${wisp.max}: ${wisp.reason})`);
    for (const m of search.matches) console.log(`  - "${m.keyword}" on ${m.url}`);
  }

  console.log(THIN);
  console.log("FIELDS");
  const texts = new Map(r.pages.map((p) => [p.url, p.text]));
  let filled = 0;
  for (const field of FACT_FIELDS) {
    const fact = d[field];
    const check = r.extraction?.fields[field];
    const retried = check?.retried ? " (retried)" : "";
    if (isFound(fact)) {
      filled++;
      const full = texts.get(fact.evidence_url);
      const inFull = full === undefined ? "page not found" : quoteInText(full, fact.evidence_quote) ? "yes" : "NO";
      console.log(`  ${field}   VERIFIED${retried}`);
      console.log(`      value : ${q(fact.value)}`);
      console.log(`      url   : ${fact.evidence_url}`);
      console.log(`      quote : ${q(fact.evidence_quote)}`);
      console.log(`      quote found in cleaned text: ${inFull}`);
    } else if (check?.status === "rejected") {
      console.log(`  ${field}   NOT_FOUND (model answer rejected${retried})`);
      if (check.firstReason) console.log(`      first pass: ${check.firstReason}`);
      console.log(`      reason: ${check.reason}`);
      if (check.answer !== undefined) console.log(`      model answer: ${q(check.answer)}`);
    } else {
      console.log(`  ${field}   NOT_FOUND`);
    }
  }

  console.log(THIN);
  console.log("SCORE BREAKDOWN");
  for (const b of r.score.breakdown) console.log(`  ${String(b.points).padStart(2)}/${String(b.max).padEnd(2)} ${b.key.padEnd(28)} ${b.reason}`);

  const rows = ctx.db
    .select()
    .from(runs)
    .where(and(eq(runs.leadId, r.leadId), gt(runs.id, firstRunId)))
    .all();
  console.log(THIN);
  console.log(`API CALLS THIS RUN${r.extraction?.fromCache ? "   (extraction served from cache: no model call)" : ""}`);
  console.log("  call type        calls   input  output  cache read  cache write        cost");
  const byType = new Map<string, { calls: number; input: number; output: number; read: number; write: number; cost: number }>();
  for (const row of rows) {
    const t = byType.get(row.callType) ?? { calls: 0, input: 0, output: 0, read: 0, write: 0, cost: 0 };
    t.calls++;
    t.input += row.inputTokens;
    t.output += row.outputTokens;
    t.read += row.cacheReadTokens;
    t.write += row.cacheWriteTokens;
    t.cost += row.costUsd;
    byType.set(row.callType, t);
  }
  let cost = 0;
  for (const [type, t] of byType) {
    cost += t.cost;
    console.log(
      `  ${type.padEnd(15)} ${String(t.calls).padStart(6)} ${String(t.input).padStart(7)} ${String(t.output).padStart(7)} ${String(t.read).padStart(11)} ${String(t.write).padStart(12)} ${usd(t.cost).padStart(11)}`,
    );
  }
  if (rows.some((x) => x.status === "error")) {
    for (const x of rows.filter((y) => y.status === "error")) console.log(`  error: ${x.callType}: ${x.error}`);
  }
  console.log(`  total cost ${usd(cost)}   month to date ${usd(ctx.gate.spentThisMonthUsd())} of $${ctx.gate.capUsd.toFixed(2)} cap`);

  return { filled, notFound: FACT_FIELDS.length - filled, retries: r.extraction?.retriesUsed ?? 0, cost };
}

const summaries: string[] = [];
let failed = 0;
for (const url of urls) {
  const leadId = leadIdFor(url);
  const firstRunId = ctx.db.select({ id: max(runs.id) }).from(runs).get()?.id ?? 0;
  try {
    const r = await researchWebLead(leadId, url, deps);
    const s = report(r, firstRunId);
    if (r.status !== "extracted") failed++;
    summaries.push(
      `${leadId}: ${s.filled}/${FACT_FIELDS.length} fields filled, ${s.notFound} NOT_FOUND, retries used ${s.retries}, cost ${usd(s.cost)}, status ${r.status}${r.extraction?.fromCache ? " (cached extraction)" : ""}`,
    );
  } catch (err) {
    failed++;
    console.error(`${leadId}: ${(err as Error).message}`);
    summaries.push(`${leadId}: ERROR ${(err as Error).message}`);
  }
}

console.log(RULE);
console.log("SUMMARY");
for (const s of summaries) console.log(`  ${s}`);
process.exit(failed === urls.length ? 1 : 0);
