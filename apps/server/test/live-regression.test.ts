import { DossierSchema, isFound, type Dossier } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/client";
import { loadMxProviders } from "../src/dns/lookup";
import { loadEvidence, loadScoring } from "../src/docs/loader";
import { loadExtractionSystemPrompt } from "../src/extract/prompt";
import { loadInjectionPatterns } from "../src/extract/untrusted";
import { loadSkipPatterns } from "../src/fetch/select";
import { userAgentFor } from "../src/fetch/site";
import { createLlmClient } from "../src/llm/client";
import { SpendGate } from "../src/llm/spend-gate";
import { researchWebLead, type ResearchReport } from "../src/pipeline/research";
import { contactPlan } from "../src/scoring/contact";
import { fakeApi, testPrices, TEST_MODEL } from "./fixtures/fakeapi";
import { fakeLimiter } from "./fixtures/fakeweb";
import { loadLiveFixture } from "./fixtures/live";

const scoring = loadScoring();
const evidence = loadEvidence();
const FAMILY = /\b(wife|husband|mother|father|mom|dad|kids|children|boys|girls|son|sons|daughter|daughters|married|pregnant|church)\b/i;

/** Re-runs a recorded live site offline: same pages, same DNS answers, same model tool calls. */
async function replay(name: string): Promise<ResearchReport> {
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
    scoring,
    evidence,
    now,
  });
}

/** Every evidence quote stored anywhere in the dossier. */
function allQuotes(d: Dossier): string[] {
  const out: string[] = [];
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "evidence_quote" && typeof x === "string") out.push(x);
        else visit(x);
      }
    }
  };
  visit(d);
  return out;
}

function commonChecks(r: ResearchReport) {
  expect(r.status).toBe("extracted");
  expect(DossierSchema.safeParse(r.dossier).success).toBe(true);
  const search = r.dossier.security_mention_search;
  if (search !== "NOT_CHECKED") expect(search.matches.map((m) => m.keyword)).not.toContain("secure portal");
  for (const q of allQuotes(r.dossier)) expect(q, "stored quote with family details").not.toMatch(FAMILY);
}

// Real pages are large; jsdom parsing makes these slower than unit tests.
describe("live regression: sites recorded from the real web (replayed offline)", { timeout: 30_000 }, () => {
  it("Pease Bell: out_of_icp on size", async () => {
    const r = await replay("peasebell-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("out_of_icp");
    expect(r.dossier.gate.reasons.join()).toMatch(/staff count \d+ is above max_staff_for_sequence 60/);
    // Signal points never count for an out_of_icp lead.
    expect(r.score.breakdown.filter((b) => b.group === "signals").every((b) => b.points === 0)).toBe(true);
  });

  it("Charles E. Harris (cehcpas): needs_review for government/nonprofit-only work", async () => {
    const r = await replay("cehcpas-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("needs_review");
    expect(r.dossier.exclusion_signals.map((s) => s.signal)).toContain("government_or_nonprofit_only");
    // An audit firm fits the target industry ("audits" in the verified services is a CPA keyword).
    expect(r.dossier.target_industry_fit.value).toBe(true);
  });

  it("Inner Circle (innercircle.cpa): qualified; the 403 on the team page stops the crawl and asks for pasted text", async () => {
    const r = await replay("innercircle-cpa");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("qualified");
    expect(r.dossier.declined_automated_access).toBe(true);
    expect(r.dossier.failures.join("\n")).toMatch(/declined_automated_access: https:\/\/innercircle\.cpa\/meet-our-team\/ answered HTTP 403.*Paste the site text/);
    // Nothing after the 403 was requested: only the pages fetched before it were opened.
    expect(r.dossier.pages_opened).toEqual(["https://innercircle.cpa/", "https://innercircle.cpa/about-our-cpa-services/"]);
    // Too few pages for the no-WISP search to count.
    expect(r.score.breakdown.find((b) => b.key === "no_wisp_mention")!.points).toBe(0);
    // firm_name from the og:site_name candidate; firm_type recovered by cutting the over-long verbatim quote.
    expect(r.dossier.firm_name).toMatchObject({ value: "Inner Circle Advisors" });
    expect(r.dossier.firm_type).toMatchObject({ value: { primary: "cpa" } });
    // marketing@ is a generic inbox: partial points and a neutral greeting.
    expect(r.dossier.public_email_kind).toBe("generic_inbox");
    expect(r.score.breakdown.find((b) => b.key === "public_business_email")!.points).toBe(5);
    expect(contactPlan(r.dossier)).toMatchObject({ greeting: "Hi,", genericInbox: true });
  });

  it("RBV Financial: qualifies only through tax preparation; no DMARC points; no family details; no secure-portal WISP hit", async () => {
    const r = await replay("rbvfinancial-com");
    commonChecks(r);
    expect(r.dossier.gate.status).toBe("qualified");
    expect(r.dossier.target_industry_fit).toMatchObject({ value: true, qualifying_type: "tax_preparer" });
    expect(isFound(r.dossier.firm_type) && r.dossier.firm_type.value.primary).toBe("credit_repair");
    expect(r.dossier.dns.no_domain_email).toMatchObject({ value: true });
    expect(r.score.breakdown.find((b) => b.key === "dmarc_missing_or_none")!.points).toBe(0);
    // The owner is named with a professional quote, never the family sentence.
    if (isFound(r.dossier.decision_maker)) expect(r.dossier.decision_maker.evidence_quote).not.toMatch(FAMILY);
    // The public address is a shared gmail box, not tied to a named person: neutral greeting, partial points.
    expect(contactPlan(r.dossier)).toMatchObject({ greeting: "Hi," });
    expect(r.dossier.public_email_kind).not.toBe("named_person");
    expect(r.score.breakdown.find((b) => b.key === "public_business_email")!.points).toBe(5);
  });
});
