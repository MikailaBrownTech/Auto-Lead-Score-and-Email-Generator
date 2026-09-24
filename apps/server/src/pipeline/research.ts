import {
  DossierSchema,
  FACT_FIELDS,
  NOT_FOUND,
  type Dossier,
  type DnsFindings,
  type ExtractedFacts,
  type InjectionFinding,
  type ScoringConfig,
  type SecurityMentionSearch,
} from "@clearpath/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { leads, type LeadStatus } from "../db/schema";
import { lookupDns, mailDomainFor, type DnsResolver, type MxProvider } from "../dns/lookup";
import { createPageCache, createRobotsStore, createTokenCounter } from "../extract/caches";
import { extractFacts, type ExtractionResult } from "../extract/extract";
import { applyTokenCaps, type CapInputPage, type SentPage } from "../extract/token-caps";
import { scanForInjection } from "../extract/untrusted";
import { fetchSite, type FetchedPage, type SiteFetchDeps } from "../fetch/site";
import { BudgetExceededError, type LlmClient } from "../llm/client";
import { scoreDossier, type ScoreResult } from "../scoring/score";
import { searchSecurityMentions } from "../scoring/security-search";

export interface ResearchDeps {
  db: Db;
  llm: LlmClient;
  modelExtract: string;
  systemPrompt: string;
  caps: { perPage: number; perLead: number };
  fetch: Omit<SiteFetchDeps, "pageCache">;
  dns: DnsResolver;
  mxProviders: MxProvider[];
  pageCacheDays: number;
  injectionPatterns: RegExp[];
  scoring: ScoringConfig;
  now: () => Date;
  /** Ignore the page and extraction caches (fresh fetch and fresh model call). */
  refresh?: boolean;
}

export interface ResearchReport {
  leadId: string;
  status: LeadStatus;
  error: string | null;
  dossier: Dossier;
  score: ScoreResult;
  pages: FetchedPage[];
  sent: SentPage[];
  extraction: ExtractionResult | null;
}

const EMPTY_DNS: DnsFindings = {
  mx_provider: NOT_FOUND,
  spf_present: NOT_FOUND,
  dmarc_present: NOT_FOUND,
  dmarc_policy: NOT_FOUND,
  dkim: "NOT_CHECKED",
};

function allNotFound(): ExtractedFacts {
  return Object.fromEntries(FACT_FIELDS.map((f) => [f, NOT_FOUND])) as ExtractedFacts;
}

function saveLead(db: Db, id: string, values: Partial<typeof leads.$inferInsert>): void {
  db.update(leads)
    .set({ ...values, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` })
    .where(eq(leads.id, id))
    .run();
}

function startLead(db: Db, id: string, source: "web" | "pasted", inputUrl: string | null): void {
  db.insert(leads)
    .values({ id, source, inputUrl, status: "researching" })
    .onConflictDoUpdate({ target: leads.id, set: { source, inputUrl, status: "researching", error: null } })
    .run();
}

interface CoreInput {
  leadId: string;
  source: "web" | "pasted";
  url: string;
  domain: string;
  pagesOpened: string[];
  capInputs: CapInputPage[];
  scanPages: { url: string; text: string; hiddenText: string }[];
  dns: DnsFindings;
  securitySearch: SecurityMentionSearch;
  failures: string[];
}

async function extractAndAssemble(input: CoreInput, deps: ResearchDeps): Promise<Omit<ResearchReport, "pages">> {
  const failures = [...input.failures];
  const findings: InjectionFinding[] = scanForInjection(input.scanPages, deps.injectionPatterns);
  let status: LeadStatus = "extracted";
  let error: string | null = null;
  let facts = allNotFound();
  let extraction: ExtractionResult | null = null;
  let sent: SentPage[] = [];

  try {
    const count = createTokenCounter(deps.db, deps.llm, deps.modelExtract);
    const capped = await applyTokenCaps(input.capInputs, deps.caps, count);
    sent = capped.sent;
    failures.push(...capped.failures);
    if (sent.length > 0) {
      extraction = await extractFacts(sent, {
        llm: deps.llm,
        db: deps.db,
        model: deps.modelExtract,
        systemPrompt: deps.systemPrompt,
        leadId: input.leadId,
        refresh: deps.refresh,
      });
      facts = extraction.facts;
      failures.push(...extraction.failures);
      if (extraction.budgetExceeded) status = "budget_exceeded";
    } else {
      failures.push("no page text could be sent to the model; all facts NOT_FOUND");
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      status = "budget_exceeded";
      error = err.message;
    } else {
      status = "failed";
      error = `${(err as Error).name}: ${(err as Error).message}`;
    }
    failures.push(`extraction stopped: ${error}`);
  }

  if (extraction?.modelFlaggedInjection) {
    findings.push({ url: input.url || "pasted", where: "model", snippet: "the extraction model reported suspected prompt injection" });
  }

  const dossier = DossierSchema.parse({
    lead_id: input.leadId,
    source: input.source,
    url: input.url,
    domain: input.domain,
    pages_opened: input.pagesOpened,
    failures: [...new Set(failures)],
    prompt_injection_flag: findings.length > 0,
    injection_findings: findings,
    ...facts,
    dns: input.dns,
    security_mention_search: input.securitySearch,
  });
  const score = scoreDossier(dossier, deps.scoring, deps.now());
  saveLead(deps.db, input.leadId, {
    status,
    error,
    dossierJson: JSON.stringify(dossier),
    score: score.total,
    tier: score.tier,
  });
  return { leadId: input.leadId, status, error, dossier, score, sent, extraction };
}

/** Research a lead from its website: fetch, DNS, keyword search, injection scan, extraction, score. */
export async function researchWebLead(leadId: string, inputUrl: string, deps: ResearchDeps): Promise<ResearchReport> {
  startLead(deps.db, leadId, "web", inputUrl);
  const cache = createPageCache(deps.db, deps.pageCacheDays, deps.now);
  const robotsStore = createRobotsStore(deps.db, deps.pageCacheDays, deps.now);
  const site = await fetchSite(inputUrl, {
    ...deps.fetch,
    // With refresh, nothing is read from the caches, but fresh answers are still written for next time.
    pageCache: deps.refresh ? { get: () => null, put: cache.put } : cache,
    robotsStore: deps.refresh ? { get: () => null, put: robotsStore.put } : robotsStore,
  });

  const failures = [...site.failures];
  let dns = EMPTY_DNS;
  if (site.domain) {
    const r = await lookupDns(mailDomainFor(site.domain), deps.dns, deps.mxProviders);
    dns = r.dns;
    failures.push(...r.failures);
  }

  const securitySearch: SecurityMentionSearch =
    site.pages.length > 0
      ? searchSecurityMentions(
          site.pages.map((p) => ({
            url: p.url,
            kind: p.kind,
            httpStatus: p.httpStatus,
            contentType: p.contentType,
            truncated: p.truncated,
            text: p.text,
            sha256: p.textSha256,
          })),
          deps.scoring.wisp_keywords,
        )
      : "NOT_CHECKED";

  const core = await extractAndAssemble(
    {
      leadId,
      source: "web",
      url: site.homeUrl ?? inputUrl,
      domain: site.domain ?? "",
      pagesOpened: site.pages.map((p) => p.url),
      capInputs: site.pages.map((p) => ({ url: p.url, kind: p.kind, text: p.text, nearEmpty: p.nearEmpty })),
      scanPages: site.pages.map((p) => ({ url: p.url, text: p.text, hiddenText: p.hiddenText })),
      dns,
      securitySearch,
      failures,
    },
    deps,
  );
  return { ...core, pages: site.pages };
}

/**
 * Paste mode: the pasted text (LinkedIn bio, About-page copy) is the only source of facts.
 * No fetching and no DNS; evidence_url is "pasted" for every fact.
 */
export async function researchPastedLead(leadId: string, pastedText: string, deps: ResearchDeps): Promise<ResearchReport> {
  startLead(deps.db, leadId, "pasted", null);
  const text = pastedText.replace(/\r\n/g, "\n").trim();
  const core = await extractAndAssemble(
    {
      leadId,
      source: "pasted",
      url: "",
      domain: "",
      pagesOpened: [],
      capInputs: [{ url: "pasted", kind: "pasted", text, nearEmpty: text.length === 0 }],
      scanPages: [{ url: "pasted", text, hiddenText: "" }],
      dns: EMPTY_DNS,
      securitySearch: "NOT_CHECKED",
      failures: ["source is pasted text only; no pages fetched and no DNS lookup"],
    },
    deps,
  );
  return { ...core, pages: [] };
}
