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
 */
import { FACT_FIELDS, isFound } from "@clearpath/shared";
import { and, gt, inArray, max } from "drizzle-orm";
import { bootstrapOrExit } from "../src/bootstrap";
import { fromRoot } from "../src/config/paths";
import { runs } from "../src/db/schema";
import { loadMxProviders, systemDnsResolver } from "../src/dns/lookup";
import { loadEvidence, loadScoring } from "../src/docs/loader";
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
const ctx = bootstrapOrExit(recorder ? { wrapApi: (api) => recorder.api(api) } : {});
const scoring = loadScoring();
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
};

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
  console.log(`${indent}url   : ${url}`);
  console.log(`${indent}quote : ${q(quote)}   (found in cleaned text: ${found})`);
}

function report(r: ResearchReport, firstRunId: number) {
  const d = r.dossier;
  const texts = new Map(r.pages.map((p) => [p.url, p.text]));
  console.log(RULE);
  console.log(`LEAD ${r.leadId}   ${d.url}`);
  console.log(`status: ${r.status}${r.error ? `   error: ${r.error}` : ""}`);
  console.log(`GATE: ${d.gate.status.toUpperCase()}${d.gate.reasons.length ? `   (${d.gate.reasons.join("; ")})` : ""}`);
  console.log(`score: ${r.score.total} (tier ${r.score.tier}${r.score.tierCapped ? `, capped at C: fit ${r.score.fitPoints} < ${scoring.fit_threshold}` : ""})   fit points ${r.score.fitPoints}`);

  console.log(THIN);
  console.log("INTERNAL LINKS DISCOVERED ON THE HOMEPAGE (decision -> fetch result)");
  if (r.links.length === 0) console.log("  (none)");
  for (const l of r.links) console.log(`  ${l.kind.padEnd(9)} ${l.url}   [${l.decision}${l.fetch ? ` -> ${l.fetch}` : ""}]`);

  console.log(THIN);
  console.log("PAGES FETCHED (pages_opened: HTTP 200 text/html only)");
  if (r.pages.length === 0) console.log("  (none)");
  for (const p of r.pages) {
    const flags = [p.fromCache ? "cached" : "fetched", p.truncated ? "TRUNCATED" : "", p.nearEmpty ? "NEAR-EMPTY" : ""].filter(Boolean).join(", ");
    console.log(`  ${p.kind.padEnd(9)} ${p.url}`);
    console.log(`            title ${q(p.title)}   ${p.text.length} chars   text sha256 ${short(p.textSha256)}   raw sha256 ${short(p.rawSha256)}   [${flags}]`);
    if (p.dates.length) console.log(`            dates: ${p.dates.map((x) => `${x.date} (${x.source})`).join(", ")}`);
  }
  console.log(`  sitemap: ${r.sitemap ? `${r.sitemap.url}, ${r.sitemap.entries.length} entries with lastmod${r.sitemap.fromCache ? " (cached)" : ""}` : "none"}`);

  console.log(THIN);
  console.log("SENT TO THE MODEL (after token caps)");
  if (r.sent.length === 0) console.log("  (nothing sent)");
  for (const s of r.sent) console.log(`  ${String(s.kind).padEnd(9)} ${s.url}   ${s.tokens} tokens${s.truncated ? "   [cut]" : ""}`);

  console.log(THIN);
  console.log("FAILURES AND NOTES");
  if (d.failures.length === 0) console.log("  (none)");
  for (const f of d.failures) console.log(`  - ${f}`);

  console.log(THIN);
  console.log(`PROMPT INJECTION: ${d.prompt_injection_flag ? "FLAGGED" : "none found"}`);
  for (const f of d.injection_findings) console.log(`  - [${f.where}] ${f.url}: ${q(f.snippet)}`);

  console.log(THIN);
  console.log("DNS (code, not the model)");
  for (const [k, v] of Object.entries(d.dns)) {
    if (typeof v === "string") console.log(`  ${k.padEnd(16)} ${v}`);
    else console.log(`  ${k.padEnd(16)} ${q(v.value)}   ${v.evidence_url}   ${q(v.evidence_quote)}`);
  }

  const search = d.security_mention_search;
  const wisp = r.score.breakdown.find((b) => b.key === "no_wisp_mention")!;
  console.log(THIN);
  console.log("SECURITY KEYWORD SEARCH (code; runs on the FULL cleaned text of every page opened, not the token-capped text)");
  if (search === "NOT_CHECKED") console.log("  not checked");
  else {
    console.log(`  ${search.pages.length} pages, ${search.matches.length} matches   (no-WISP points ${wisp.points}/${wisp.max}: ${wisp.reason})`);
    for (const m of search.matches) console.log(`  - "${m.keyword}" on ${m.url}`);
  }

  console.log(THIN);
  console.log("CODE-DERIVED FIELDS");
  console.log(`  decision_maker      ${isFound(d.decision_maker) ? `${q(d.decision_maker.value)}   (from people, by title preference)` : "NOT_FOUND"}`);
  if (isFound(d.decision_maker)) printEvidence(d.decision_maker.evidence_url, d.decision_maker.evidence_quote, texts);
  const plan = contactPlan(d);
  console.log(`  greeting            ${q(plan.greeting)}   contact_mismatch: ${plan.contactMismatch}   (${plan.reason})`);
  console.log(`  us_location         ${q(d.us_location.value)}   (${d.us_location.reason})`);
  console.log(`  target_industry_fit ${q(d.target_industry_fit.value)}   (${d.target_industry_fit.reason})`);
  const fresh = d.latest_dated_content;
  console.log(`  latest_dated_content ${isFound(fresh) ? `${fresh.value.date} from ${fresh.value.source}   ${fresh.evidence_url}   ${q(fresh.evidence_quote)}` : "NOT_FOUND (no machine-readable date)"}`);

  console.log(THIN);
  console.log("MODEL FIELDS");
  let filled = 0;
  for (const field of FACT_FIELDS) {
    const fact = d[field] as unknown;
    const check = r.extraction?.fields[field];
    const retried = check?.retried ? " (retried)" : "";
    const empty = fact === "NOT_FOUND" || (Array.isArray(fact) && fact.length === 0);
    if (!empty) {
      filled++;
      console.log(`  ${field}   VERIFIED${retried}`);
      if (Array.isArray(fact)) {
        for (const item of fact as { evidence_url: string; evidence_quote: string }[]) {
          const { evidence_url, evidence_quote, ...rest } = item;
          console.log(`    - ${q(rest)}`);
          printEvidence(evidence_url, evidence_quote, texts, "        ");
        }
      } else if (typeof fact === "object" && fact !== null && "evidence" in fact) {
        const f = fact as { value: unknown; evidence: { evidence_url: string; evidence_quote: string }[] };
        console.log(`      value : ${q(f.value)}`);
        for (const e of f.evidence) printEvidence(e.evidence_url, e.evidence_quote, texts);
      } else {
        const f = fact as { value: unknown; evidence_url: string; evidence_quote: string };
        console.log(`      value : ${q(f.value)}`);
        printEvidence(f.evidence_url, f.evidence_quote, texts);
      }
    } else if (check?.status === "rejected") {
      console.log(`  ${field}   NOT_FOUND (model answer rejected: ${check.kind}${retried})`);
      if (check.firstReason) console.log(`      first pass: ${check.firstReason}`);
      console.log(`      reason: ${check.reason}`);
      if (check.answer !== undefined) console.log(`      model answer: ${q(check.answer)}`);
    } else {
      console.log(`  ${field}   ${Array.isArray(fact) ? "none" : "NOT_FOUND"}`);
    }
  }

  console.log(THIN);
  console.log("SCORE BREAKDOWN");
  for (const b of r.score.breakdown) console.log(`  ${String(b.points).padStart(2)}/${String(b.max).padEnd(2)} ${b.group.padEnd(12)} ${b.key.padEnd(28)} ${b.reason}`);

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
for (const r of reports) {
  const s = report(r, firstRunId);
  summaries.push(
    `${r.leadId}: gate ${r.dossier.gate.status}, score ${r.score.total} tier ${r.score.tier}, ${s.filled}/${FACT_FIELDS.length} model fields filled, ${s.notFound} NOT_FOUND, retries used ${s.retries}, cost ${usd(s.cost)}${r.extraction?.fromCache ? " (cached extraction)" : ""}`,
  );
}

console.log(RULE);
console.log(`WISP KEYWORDS (docs/06, ${scoring.wisp_keywords.length}): ${scoring.wisp_keywords.map((k) => q(k)).join(", ")}`);
console.log(RULE);
console.log("RUN COST SUMMARY (this command)");
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
console.log("  call type        calls   input  output  cache read  cache write        cost");
for (const [type, t] of byType) {
  console.log(`  ${type.padEnd(15)} ${String(t.calls).padStart(6)} ${String(t.input).padStart(7)} ${String(t.output).padStart(7)} ${String(t.read).padStart(11)} ${String(t.write).padStart(12)} ${usd(t.cost).padStart(11)}`);
}
for (const x of all.filter((y) => y.status === "error")) console.log(`  error: ${x.leadId} ${x.callType}: ${x.error}`);
const total = all.reduce((s, x) => s + x.costUsd, 0);
console.log(`  total ${usd(total)} for ${reports.length} lead(s)   month to date ${usd(ctx.gate.spentThisMonthUsd())} of $${ctx.gate.capUsd.toFixed(2)} cap`);
console.log(RULE);
console.log("SUMMARY");
for (const s of summaries) console.log(`  ${s}`);

if (recorder) {
  const dirs = recorder.save(fromRoot("apps/server/test/fixtures/live"));
  console.log(RULE);
  console.log("FIXTURES SAVED");
  for (const d of dirs) console.log(`  ${d}`);
}
process.exit(reports.every((r) => r.status !== "extracted") ? 1 : 0);
