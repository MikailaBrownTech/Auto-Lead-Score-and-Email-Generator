import {
  DossierSchema,
  FACT_FIELDS,
  NOT_FOUND,
  type Dossier,
  type DnsFindings,
  type EvidenceConfig,
  type ExtractedFacts,
  type InjectionFinding,
  type NameHint,
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
import type { PageDate } from "../fetch/clean";
import { fetchSite, type FetchedPage, type LinkReport, type SiteFetchDeps, type SitemapResult } from "../fetch/site";
import { BudgetExceededError, lastRunId, type LlmClient } from "../llm/client";
import { chooseDecisionMaker, computeGate, supportedSecondaryTypes, targetIndustryFit, usLocation } from "../scoring/derive";
import { classifyPublicEmail } from "../scoring/contact";
import { computeFreshness } from "../scoring/freshness";
import { scoreDossier, type ScoreResult } from "../scoring/score";
import { searchSecurityMentions } from "../scoring/security-search";

export interface ResearchDeps {
  db: Db;
  llm: LlmClient;
  modelExtract: string;
  systemPrompt: string;
  caps: { perPage: number; perLead: number };
  fetch: Omit<SiteFetchDeps, "pageCache" | "robotsStore">;
  dns: DnsResolver;
  mxProviders: MxProvider[];
  pageCacheDays: number;
  injectionPatterns: RegExp[];
  scoring: ScoringConfig;
  evidence: EvidenceConfig;
  now: () => Date;
  /** Ignore the page, robots, and extraction caches (fresh fetch and fresh model call). */
  refresh?: boolean;
  /** docs/01 allow_generic_inbox_outreach. When false, generic-inbox leads become needs_direct_contact. */
  allowGenericInbox?: boolean;
}

export interface ResearchReport {
  leadId: string;
  status: LeadStatus;
  error: string | null;
  dossier: Dossier;
  score: ScoreResult;
  pages: FetchedPage[];
  sent: SentPage[];
  links: LinkReport[];
  sitemap: SitemapResult | null;
  extraction: ExtractionResult | null;
}

/** Everything gathered before the model is called (fetch, DNS, keyword search). */
export interface PreparedLead {
  leadId: string;
  source: "web" | "pasted";
  url: string;
  domain: string;
  pages: FetchedPage[];
  links: LinkReport[];
  sitemap: SitemapResult | null;
  capInputs: CapInputPage[];
  scanPages: { url: string; text: string; hiddenText: string }[];
  datedPages: { url: string; kind: FetchedPage["kind"]; dates: PageDate[] }[];
  dns: DnsFindings;
  securitySearch: SecurityMentionSearch;
  failures: string[];
  /** Firm-name candidates from the homepage markup (hints for the model). */
  nameHints: NameHint[];
  /** The site answered HTTP 403/429 and was not requested again this run. */
  declined: boolean;
}

const EMPTY_DNS: DnsFindings = {
  mx_provider: NOT_FOUND,
  no_domain_email: NOT_FOUND,
  spf_present: NOT_FOUND,
  dmarc_present: NOT_FOUND,
  dmarc_policy: NOT_FOUND,
  dkim: "NOT_CHECKED",
};

function emptyFacts(): ExtractedFacts {
  return Object.fromEntries(FACT_FIELDS.map((f) => [f, f === "people" || f === "exclusion_signals" ? [] : NOT_FOUND])) as unknown as ExtractedFacts;
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

/**
 * Model facts -> dossier: keeps only secondary types the services show, picks the decision maker by
 * title preference, computes US location, target industry fit, freshness, and the gate. All code.
 */
export function assembleDossier(p: PreparedLead, facts: ExtractedFacts, extra: { failures: string[]; findings: InjectionFinding[] }, deps: Pick<ResearchDeps, "scoring" | "evidence" | "now">): Dossier {
  const failures = [...extra.failures];
  const secondary = supportedSecondaryTypes(facts.firm_type, facts.services, deps.evidence.firm_type_keywords);
  failures.push(...secondary.notes);
  const firmType = secondary.firmType;
  const fit = targetIndustryFit(firmType, facts.services, deps.scoring, deps.evidence.firm_type_keywords);
  const gate = computeGate({ sizeSignal: facts.size_signal, targetIndustryFit: fit, exclusionSignals: facts.exclusion_signals, scoring: deps.scoring });
  return DossierSchema.parse({
    lead_id: p.leadId,
    source: p.source,
    url: p.url,
    domain: p.domain,
    pages_opened: p.pages.map((pg) => pg.url),
    failures: [...new Set(failures)],
    prompt_injection_flag: extra.findings.length > 0,
    injection_findings: extra.findings,
    declined_automated_access: p.declined,
    firm_name_candidates: p.nameHints,
    ...facts,
    firm_type: firmType,
    decision_maker: chooseDecisionMaker(facts.people, deps.evidence.decision_maker_title_preferences),
    public_email_kind: classifyPublicEmail(facts.public_contact_email, facts.people, deps.evidence.generic_inbox_prefixes),
    latest_dated_content: p.source === "web" ? computeFreshness(p.datedPages, p.sitemap, deps.now()) : NOT_FOUND,
    us_location: usLocation(facts.location),
    target_industry_fit: fit,
    gate,
    dns: p.dns,
    security_mention_search: p.securitySearch,
  });
}

/** Phase 1 for a website lead: fetch (cache-aware), DNS, and the full-text keyword search. No model calls. */
export async function prepareWebLead(leadId: string, inputUrl: string, deps: ResearchDeps): Promise<PreparedLead> {
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

  // Runs on the full cleaned text of every page opened, never on the token-capped copy.
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

  return {
    leadId,
    source: "web",
    url: site.homeUrl ?? inputUrl,
    domain: site.domain ?? "",
    pages: site.pages,
    links: site.links,
    sitemap: site.sitemap,
    capInputs: site.pages.map((p) => ({ url: p.url, kind: p.kind, title: p.title, text: p.text, nearEmpty: p.nearEmpty })),
    scanPages: site.pages.map((p) => ({ url: p.url, text: p.text, hiddenText: p.hiddenText })),
    datedPages: site.pages.map((p) => ({ url: p.url, kind: p.kind, dates: p.dates })),
    dns,
    securitySearch,
    failures,
    nameHints: site.pages.find((pg) => pg.kind === "home")?.nameHints ?? [],
    declined: site.declined !== null,
  };
}

/** Phase 2: token caps, extraction (with its one targeted retry), dossier, gate, score. */
export async function completeLead(p: PreparedLead, deps: ResearchDeps): Promise<ResearchReport> {
  const failures = [...p.failures];
  const findings: InjectionFinding[] = scanForInjection(p.scanPages, deps.injectionPatterns);
  let status: LeadStatus = "extracted";
  let error: string | null = null;
  let facts = emptyFacts();
  let extraction: ExtractionResult | null = null;
  let sent: SentPage[] = [];

  const budgetSinceRunId = lastRunId(deps.db);
  try {
    const count = createTokenCounter(deps.db, deps.llm, deps.modelExtract);
    const capped = await applyTokenCaps(p.capInputs, deps.caps, count);
    sent = capped.sent;
    failures.push(...capped.failures);
    if (sent.length > 0) {
      extraction = await extractFacts(sent, {
        llm: deps.llm,
        db: deps.db,
        model: deps.modelExtract,
        systemPrompt: deps.systemPrompt,
        evidence: deps.evidence,
        leadId: p.leadId,
        budgetSinceRunId,
        refresh: deps.refresh,
        // services/software items are searched in the full cleaned text, not the token-capped copy.
        searchPages: p.scanPages.map(({ url, text }) => ({ url, text })),
        nameHints: p.nameHints,
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
    findings.push({ url: p.url || "pasted", where: "model", snippet: "the extraction model reported suspected prompt injection" });
  }

  const dossier = assembleDossier(p, facts, { failures, findings }, deps);
  const score = scoreDossier(dossier, deps.scoring, deps.now());
  if (status === "extracted" && dossier.public_email_kind === "generic_inbox" && !deps.allowGenericInbox) status = "needs_direct_contact";
  saveLead(deps.db, p.leadId, {
    status,
    error,
    dossierJson: JSON.stringify(dossier),
    score: score.total,
    tier: score.tier,
    gateStatus: dossier.gate.status,
    gateReasonsJson: JSON.stringify(dossier.gate.reasons),
  });
  return { leadId: p.leadId, status, error, dossier, score, sent, extraction, pages: p.pages, links: p.links, sitemap: p.sitemap };
}

/** Research a lead from its website: fetch, DNS, keyword search, injection scan, extraction, gate, score. */
export async function researchWebLead(leadId: string, inputUrl: string, deps: ResearchDeps): Promise<ResearchReport> {
  return completeLead(await prepareWebLead(leadId, inputUrl, deps), deps);
}

/**
 * Paste mode: the pasted text (LinkedIn bio, About-page copy) is the only source of facts.
 * No fetching and no DNS; evidence_url is "pasted" for every fact.
 */
export async function researchPastedLead(leadId: string, pastedText: string, deps: ResearchDeps): Promise<ResearchReport> {
  startLead(deps.db, leadId, "pasted", null);
  const text = pastedText.replace(/\r\n/g, "\n").trim();
  return completeLead(
    {
      leadId,
      source: "pasted",
      url: "",
      domain: "",
      pages: [],
      links: [],
      sitemap: null,
      capInputs: [{ url: "pasted", kind: "pasted", title: "", text, nearEmpty: text.length === 0 }],
      scanPages: [{ url: "pasted", text, hiddenText: "" }],
      datedPages: [],
      dns: EMPTY_DNS,
      securitySearch: "NOT_CHECKED",
      failures: ["source is pasted text only; no pages fetched and no DNS lookup"],
      nameHints: [],
      declined: false,
    },
    deps,
  );
}
