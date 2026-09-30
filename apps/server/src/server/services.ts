import type { Env } from "../config/env";
import type { Db } from "../db/client";
import type { EventsDb, SequencesDb } from "../db/supa-sequences";
import type { LeadsDb } from "../db/supa-leads";
import type { RunsDb } from "../db/supa-runs";
import type { SettingsDb } from "../db/supa-settings";
import type { SuppressionDb } from "../db/supa-suppression";
import { loadMxProviders, systemDnsResolver, type DnsResolver } from "../dns/lookup";
import { DOCS_DIR, loadApprovedSentences, loadEvidence, loadScoring, loadStyle, loadWriterFacts } from "../docs/loader";
import { loadTemplates } from "../docs/templates";
import { loadExtractionSystemPrompt, PROMPTS_DIR } from "../extract/prompt";
import { loadInjectionPatterns } from "../extract/untrusted";
import { HostRateLimiter } from "../fetch/rate-limit";
import { loadSkipPatterns } from "../fetch/select";
import { userAgentFor } from "../fetch/site";
import { systemResolver, undiciTransport, type HttpTransport, type Resolver } from "../fetch/transport";
import type { LlmClient } from "../llm/client";
import type { SpendGate } from "../llm/spend-gate";
import type { ResearchDeps } from "../pipeline/research";
import type { WriteDeps } from "../write/generate";
import { examplesFor, loadExampleSequences, loadJudgeSystemPrompt, loadPersonaHeadings, loadWriterSystemPrompt } from "../write/prompt";

export type ServiceEnv = Pick<
  Env,
  "MODEL_EXTRACT" | "MODEL_WRITE" | "MAX_TOKENS_PER_PAGE" | "MAX_INPUT_TOKENS_PER_LEAD" | "FETCH_TIMEOUT_MS" | "FETCH_MAX_BYTES" | "PAGE_CACHE_DAYS" | "CONTACT_URL"
>;

/** Everything the API needs to research and write. Tests replace the network, DNS, the model, and every *Db. */
export interface Services {
  /** The SQLite cache DB only (pages, robots_txt, token_counts, extractions). */
  db: Db;
  leadsDb: LeadsDb;
  sequencesDb: SequencesDb;
  eventsDb: EventsDb;
  runsDb: RunsDb;
  suppressionDb: SuppressionDb;
  settingsDb: SettingsDb;
  llm: LlmClient;
  gate: SpendGate;
  env: ServiceEnv;
  docsDir?: string;
  promptsDir?: string;
  backupDir?: string;
  net?: { resolver: Resolver; transport: HttpTransport; dns: DnsResolver; limiter?: HostRateLimiter };
  now?: () => Date;
}

/** One limiter per process, so 1 request/second/host holds across jobs. */
const sharedLimiter = new HostRateLimiter(1000);

/**
 * Research dependencies. The docs are read on every call, so a settings change applies to the next
 * lead without a restart.
 */
export function researchDeps(s: Services, opts: { refresh?: boolean } = {}): ResearchDeps {
  const docsDir = s.docsDir ?? DOCS_DIR;
  return {
    db: s.db,
    leadsDb: s.leadsDb,
    eventsDb: s.eventsDb,
    runsDb: s.runsDb,
    llm: s.llm,
    modelExtract: s.env.MODEL_EXTRACT,
    systemPrompt: loadExtractionSystemPrompt(s.promptsDir ?? PROMPTS_DIR, docsDir),
    caps: { perPage: s.env.MAX_TOKENS_PER_PAGE, perLead: s.env.MAX_INPUT_TOKENS_PER_LEAD },
    fetch: {
      resolver: s.net?.resolver ?? systemResolver,
      transport: s.net?.transport ?? undiciTransport,
      userAgent: userAgentFor(s.env.CONTACT_URL),
      timeoutMs: s.env.FETCH_TIMEOUT_MS,
      maxBytes: s.env.FETCH_MAX_BYTES,
      skipPatterns: loadSkipPatterns(),
      limiter: s.net?.limiter ?? sharedLimiter,
      ...(s.now ? { now: s.now } : {}),
    },
    dns: s.net?.dns ?? systemDnsResolver,
    mxProviders: loadMxProviders(),
    pageCacheDays: s.env.PAGE_CACHE_DAYS,
    injectionPatterns: loadInjectionPatterns(),
    scoring: loadScoring(docsDir),
    evidence: loadEvidence(docsDir),
    now: s.now ?? (() => new Date()),
    refresh: opts.refresh ?? false,
  };
}

/**
 * Sequence dependencies, with the docs read fresh. Writer and judge use MODEL_WRITE and see only the
 * compact dossier values. The writer prompt holds two of the docs/03 example sequences, rotated by lead
 * id; each pair's prompt is built once per deps object.
 */
export async function writeDeps(s: Services): Promise<WriteDeps> {
  const docsDir = s.docsDir ?? DOCS_DIR;
  const offer = await s.settingsDb.getOffer();
  const facts = loadWriterFacts(docsDir);
  const style = loadStyle(docsDir);
  return {
    leadsDb: s.leadsDb,
    sequencesDb: s.sequencesDb,
    eventsDb: s.eventsDb,
    runsDb: s.runsDb,
    llm: s.llm,
    modelWrite: s.env.MODEL_WRITE,
    writerSystem: writerSystemFor({ offer, facts, docsDir, style, ...(s.promptsDir ? { promptsDir: s.promptsDir } : {}) }),
    judgeSystem: loadJudgeSystemPrompt({ offer, facts, docsDir, ...(s.promptsDir ? { promptsDir: s.promptsDir } : {}) }),
    style,
    offer,
    evidence: loadEvidence(docsDir),
    templates: loadTemplates(docsDir),
    facts,
    approved: loadApprovedSentences(docsDir).sentences,
    personas: loadPersonaHeadings(docsDir),
  };
}

/** The writer system prompt per lead (example pair rotated by lead id), memoized by pair. */
export function writerSystemFor(sources: Omit<Parameters<typeof loadWriterSystemPrompt>[0], "exampleIds">): (leadId: string) => string {
  const examples = loadExampleSequences(sources.docsDir);
  const cache = new Map<string, string>();
  return (leadId) => {
    const ids = examplesFor(leadId, examples);
    const key = ids.join(",");
    if (!cache.has(key)) cache.set(key, loadWriterSystemPrompt({ ...sources, exampleIds: ids }));
    return cache.get(key)!;
  };
}
