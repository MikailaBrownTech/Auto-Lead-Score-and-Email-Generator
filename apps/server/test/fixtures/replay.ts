import { openDb } from "../../src/db/client";
import { loadMxProviders } from "../../src/dns/lookup";
import { loadEvidence, loadScoring } from "../../src/docs/loader";
import { loadExtractionSystemPrompt } from "../../src/extract/prompt";
import { loadInjectionPatterns } from "../../src/extract/untrusted";
import { loadSkipPatterns } from "../../src/fetch/select";
import { userAgentFor } from "../../src/fetch/site";
import { createLlmClient } from "../../src/llm/client";
import { SpendGate } from "../../src/llm/spend-gate";
import { researchWebLead, type ResearchReport } from "../../src/pipeline/research";
import { fakeApi, testPrices, TEST_MODEL } from "./fakeapi";
import { fakeLimiter } from "./fakeweb";
import { loadLiveFixture } from "./live";

/** Re-runs a recorded live site offline: same pages, same DNS answers, same model tool calls. */
export async function replay(name: string): Promise<ResearchReport> {
  const fx = loadLiveFixture(name);
  const now = () => new Date(fx.manifest.capturedAt);
  const db = openDb(":memory:");
  const { api } = fakeApi((_p, i) => {
    const input = fx.toolInputs[i];
    if (!input) throw new Error(`${name}: no recorded model call #${i}`);
    return input as Record<string, unknown>;
  });
  const llm = createLlmClient({ api, db, prices: testPrices, gate: new SpendGate(db, 5, now), leadTokenBudget: 1_000_000, backoff: { sleep: async () => undefined } });
  return researchWebLead(`live-${name}`, fx.manifest.input, {
    db,
    llm,
    modelExtract: TEST_MODEL,
    systemPrompt: loadExtractionSystemPrompt(),
    caps: { perPage: 6000, perLead: 30000 },
    fetch: {
      resolver: fx.web.resolver,
      transport: fx.web.transport,
      userAgent: userAgentFor("https://www.clearpathsecure.com/contact"),
      timeoutMs: 1000,
      maxBytes: 2_000_000,
      skipPatterns: loadSkipPatterns(),
      limiter: fakeLimiter().limiter,
      now,
    },
    dns: fx.dns,
    mxProviders: loadMxProviders(),
    pageCacheDays: 7,
    injectionPatterns: loadInjectionPatterns(),
    scoring: loadScoring(),
    evidence: loadEvidence(),
    now,
  });
}
