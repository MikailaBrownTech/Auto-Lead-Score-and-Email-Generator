# PROGRESS

Status snapshot for resuming work. Rules and stack are in CLAUDE.md; this file does not repeat them.

## Milestones
- [x] M0 Scaffold, zod env, spend cap + worst-case reservation, price table, runs logging, localhost guard
- [x] M1 Shared schemas, docs config blocks + safe write-back, scoring, validators, template emails (docs/09)
- [x] M2 Fetching (SSRF guard, robots, 1 req/s/host, Readability), DNS
- [x] M3 Extraction with evidence enforcement, caches, token caps, targeted retry, injection handling,
      gates, deterministic freshness, live-site regression fixtures
- [ ] M4 Writing and validation (next, see below)
- [ ] M5 UI, M6 Results + settings, M7 Hardening

Tests: 385 passing in 22 files (vitest). Typecheck clean (strict). Last commit: 7767c68.

## Key decisions and settings
- Gates (docs/06): out_of_icp when staff_count > max_staff_for_sequence (60) or target_industry_fit
  is false; needs_review on any model-reported exclusion signal. No sequence for a gated lead until
  the founder approves (leads.gate_approved; UI in M5). Signal points count only if not out_of_icp;
  tier capped at C below fit_threshold (20).
- Scope is code-decided: us_location and target_industry_fit from firm_type + services keyword lists
  (docs/06 evidence block). credit_repair is its own type, not a target; qualifies only via a
  secondary target type shown in services.
- cta_type = checklist (docs/01). Scorecard variant exists but must not be used until it exists.
- include_dns_observation: decided default false (no DMARC/SPF remark in emails). NOT YET IMPLEMENTED;
  add as a docs/01 offer setting in M4.
- Spend: MONTHLY_SPEND_CAP_USD in .env (currently $5); each call reserves worst case first.
  Month to date about $0.29.
- Per-lead budget: LEAD_TOKEN_BUDGET 60000 tokens per research run (not lifetime). Input caps:
  6000 tokens/page, 30000/lead (counted by the count_tokens API, cached by text hash).
- Models: MODEL_EXTRACT claude-haiku-4-5-20251001, MODEL_WRITE claude-sonnet-5. Prices in
  config/prices.json (source + date recorded).
- Retry: one targeted retry, fixable failures only (quote not found/too long, support mismatch,
  personal details, wrong page); partial lists retried and merged. Format failures never retried.
- DMARC scored only when MX exists (no_domain_email recorded). DNS lookup failures never scored.
- No-WISP points: code keyword search of full page text; needs home + privacy/security page or 3+
  complete pages. "secure portal" removed from keywords.
- Freshness: machine-readable dates only (time, article:published_time, JSON-LD, sitemap lastmod);
  policy pages excluded.
- Greeting: decision maker by name only if the public address is theirs; else "Hi," + contact_mismatch.
- Page cache and robots.txt answers reused for PAGE_CACHE_DAYS (7). Crawl-delay > 10s skips a site.

## Known open issues
1. One retry sometimes loses facts (Pease Bell firm_name, Managing Partner). Option: a second retry
   limited to firm_name and people (~$0.005/lead). Founder to decide.
2. RBV qualifies via the tax_preparer keyword "tax filing"; confirm that keyword belongs in docs/06.
3. Team pages under /who-we-are/ classify as "about", so only one is fetched (cehcpas got 2 pages).
4. Gated leads still get a score and tier; UI must show the gate first.
5. Playwright fallback not built (0 of 3 live sites needed it); JS-only pages are recorded as failures.
6. Node 22.14 pins undici 7 and jsdom 29 (newer majors need Node 22.19+/22.22+).
7. Template email 2 for credit_repair falls back to the "other" variant.

## How to run (from repo root)
- Tests: `npm test`  (offline; fixtures + fake network/API)
- Typecheck: `npm run typecheck`
- Smoke (1 tiny live API call): `npm run smoke`
- Live extraction check: `npm run extract-live -- <url> [<url>...] [--refresh] [--record]`
  (batch: fetch all, then extract; `--record` saves regression fixtures)
- Dev: `npm run dev:server` (127.0.0.1:8787) and `npm run dev:web` (Vite 5173, proxies /api with token)
- Migrations: `npm run db:generate` after editing apps/server/src/db/schema.ts

## File map
- docs/01,02,03,04,06,08,09 - offer, VERIFIED facts, style, dossier schema, scoring + evidence lists, personas, templates
- prompts/extract.md - extraction system prompt (docs/04 inserted at runtime)
- config/prices.json, skip-patterns.json, mx-providers.json, injection-patterns.json
- packages/shared/src/dossier.ts - dossier/facts zod schemas, writerView (values only)
- packages/shared/src/settings.ts - offer/style/scoring/evidence block schemas
- packages/shared/src/sequence.ts - sequence schema, grounding fields
- apps/server/src/config/env.ts - .env validation
- apps/server/src/llm/client.ts - only API path: count, budget, reserve, backoff, runs log
- apps/server/src/llm/spend-gate.ts, cost.ts, cache-health.ts, limits.ts
- apps/server/src/docs/loader.ts, blocks.ts, templates.ts - docs blocks read/write, templates
- apps/server/src/fetch/guarded-fetch.ts, ip-guard.ts, transport.ts - SSRF-safe fetching
- apps/server/src/fetch/robots.ts, rate-limit.ts, clean.ts, select.ts, site.ts - site crawl
- apps/server/src/fetch/recording.ts - --record fixture capture
- apps/server/src/dns/lookup.ts - MX/SPF/DMARC, no_domain_email
- apps/server/src/extract/verify.ts - per-field evidence and support checks
- apps/server/src/extract/extract.ts, prompt.ts, token-caps.ts, untrusted.ts, caches.ts
- apps/server/src/scoring/score.ts, derive.ts, freshness.ts, contact.ts, security-search.ts
- apps/server/src/pipeline/research.ts - prepare/complete lead, gate, save
- apps/server/src/validators/email.ts - deterministic email checks
- apps/server/scripts/extract-live.ts, smoke.ts
- apps/server/test/fixtures/live/ - Pease Bell, cehcpas, RBV recordings (byte-exact)

## Next: M4 Writing and validation
Build: writer (MODEL_WRITE, sees writerView values + writerFacts + docs/03/08 only, cached static
prefix), tier gating (A custom; B custom 1-2 + templates 3-5; C templates only, no LLM), judge
(A/B only) listing unsupported claims, include_dns_observation setting, approval blocked until PASS.
Acceptance:
- No sequence generated for out_of_icp/needs_review leads unless gate_approved.
- Tier C makes zero write/judge calls; judge never runs on C.
- Writer input contains no evidence quotes, no URLs, no dollar/penalty facts (test asserts).
- Every sequence passes validators (incl. greeting/contact rule) and judge before approval is allowed.
- DNS remarks appear only when include_dns_observation is true and the finding is evidenced.
- Per-call max_tokens, runs logging with call types write/judge; cache reads > 0 on the second lead.
- Tests pass offline; one live batch on the three fixture sites reported before M5.

## Never break
- Every fact: evidence (url + verbatim quote <= 15 words, value inside its quote) or NOT_FOUND; enforced in code.
- No proof claims unless in approved_proof; never claim DKIM status.
- No penalty amounts or dollar figures in prompts, templates, or emails.
- Writer and judge get values only, never evidence quotes or raw page text.
- Honest crawler: ClearPathLeadConsole/0.1 (+CONTACT_URL) user agent, never spoofed; obey robots.txt,
  1 req/s/host, SSRF guard on every hop; passive public data only.
- Fetched/pasted text is untrusted data, only in delimited user-message blocks; hidden text never sent.
