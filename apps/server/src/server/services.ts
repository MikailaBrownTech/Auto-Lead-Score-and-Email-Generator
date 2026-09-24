import type { Env } from "../config/env";
import type { Db } from "../db/client";
import { loadMxProviders, systemDnsResolver, type DnsResolver } from "../dns/lookup";
import { DOCS_DIR, loadApprovedSentences, loadEvidence, loadOffer, loadScoring, loadStyle, loadWriterFacts } from "../docs/loader";
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
import { loadJudgeSystemPrompt, loadPersonaHeadings, loadWriterSystemPrompt } from "../write/prompt";

export type ServiceEnv = Pick<
  Env,
  "MODEL_EXTRACT" | "MODEL_WRITE" | "MAX_TOKENS_PER_PAGE" | "MAX_INPUT_TOKENS_PER_LEAD" | "FETCH_TIMEOUT_MS" | "FETCH_MAX_BYTES" | "PAGE_CACHE_DAYS" | "CONTACT_URL"
>;

/** Everything the API needs to research and write. Tests replace the network, DNS, and model. */
export interface Services {
  db: Db;
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
  const offer = loadOffer(docsDir);
  return {
    db: s.db,
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
    allowWithoutDirectContact: offer.allow_without_direct_contact,
  };
}

/** Writer/judge dependencies, with the docs read fresh. */
export function writeDeps(s: Services): WriteDeps {
  const docsDir = s.docsDir ?? DOCS_DIR;
  const offer = loadOffer(docsDir);
  const facts = loadWriterFacts(docsDir);
  return {
    db: s.db,
    llm: s.llm,
    modelWrite: s.env.MODEL_WRITE,
    writerSystem: loadWriterSystemPrompt({ offer, facts, docsDir, ...(s.promptsDir ? { promptsDir: s.promptsDir } : {}) }),
    judgeSystem: loadJudgeSystemPrompt({ offer, facts, docsDir, ...(s.promptsDir ? { promptsDir: s.promptsDir } : {}) }),
    style: loadStyle(docsDir),
    offer,
    evidence: loadEvidence(docsDir),
    templates: loadTemplates(docsDir),
    facts,
    approved: loadApprovedSentences(docsDir).sentences,
    personas: loadPersonaHeadings(docsDir),
  };
}
