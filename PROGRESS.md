# PROGRESS

Status snapshot for resuming work. Rules and stack are in CLAUDE.md; this file does not repeat them.

## Milestones
- [x] M0 Scaffold, zod env, spend cap + worst-case reservation, price table, runs logging, localhost guard
- [x] M1 Shared schemas, docs config blocks + safe write-back, scoring, validators, template emails (docs/09)
- [x] M2 Fetching (SSRF guard, robots, 1 req/s/host, Readability), DNS
- [x] M3 Extraction with evidence enforcement, caches, token caps, targeted retry, injection handling,
      gates, deterministic freshness, live-site regression fixtures
- [x] Report-3 fixes: firm-name candidates, list items verified by page search, 403/429
      declined_automated_access, url_date freshness + one dated post, generic inboxes, role_unconfirmed,
      security mention definition, recent_signal removed, over-long verbatim quotes cut by code, plural
      keywords; 4 sites re-recorded as fixtures
- [x] M4 Writer + judge (no UI), CLI `npm run write-sequence -- <url>`. AWAITING FOUNDER REVIEW
- [ ] M5 UI, M6 Results + settings, M7 Hardening

Tests: 427 passing in 24 files (vitest). Typecheck clean (strict). Month to date about $0.54 of $5.

## Key decisions and settings
- Gates (docs/06): out_of_icp when staff_count > max_staff_for_sequence (60) or target_industry_fit
  is false; needs_review on any model-reported exclusion signal. No sequence for a gated lead until
  the founder approves (leads.gate_approved; UI in M5). Signal points count only if not out_of_icp;
  tier capped at C below fit_threshold (20).
- Scope is code-decided: us_location and target_industry_fit from firm_type + services keyword lists
  (docs/06 evidence block; plurals match). credit_repair is its own type, not a target; qualifies only
  via a secondary target type shown in services.
- cta_type = checklist (docs/01). Scorecard variant exists but must not be used until it exists.
- include_dns_observation: docs/01 offer setting, default false. When true: MX required, code-worded
  hedged remark; validators block alarm words, DKIM, and ungrounded DNS mentions.
- Public email: 10 pts when tied to a named person, 5 for generic_inbox or unattributed (docs/06
  partial_points, generic_inbox_prefixes). A generic inbox is never greeted by name.
- Decision maker: 10 pts only when the title is on the preference list; else 5 + role_unconfirmed.
- 403/429 from a prospect site (robots.txt included): stop that host for the run, never retry, same UA,
  paste-text prompt in the report. Extraction uses the pages already fetched.
- services/software: plain lists from the model; code keeps items found (normalized, whole phrase) in
  a fetched page's full text; evidence = {item, evidence_url}. Never retried.
- Over-long quotes that are verbatim are cut by code to the first 15-word window holding the value
  (firm_name, firm_type, location, email, phone). firm_name quotes may come from the page title.
- Spend: MONTHLY_SPEND_CAP_USD in .env (currently $5); each call reserves worst case first.
- Per-lead budget: LEAD_TOKEN_BUDGET 60000 tokens per run (research run, and separately the write run).
  Input caps: 6000 tokens/page, 30000/lead (count_tokens API, cached by text hash).
- Models: MODEL_EXTRACT claude-haiku-4-5-20251001, MODEL_WRITE claude-sonnet-5 (writer and judge,
  forced tool call, thinking disabled). Prices in config/prices.json (source + date recorded).
- Retry: one targeted extraction retry, fixable failures only. Writer: one rewrite on validator errors.
- DMARC scored only when MX exists (no_domain_email recorded). DNS lookup failures never scored.
- No-WISP points: code keyword search of full page text; needs home + privacy/security page or 3+
  complete pages.
- Freshness: machine-readable dates only; url_date (/YYYY/MM/DD/ path) only when none exist.
- Tiers: A writer emails 1-5; B writer 1-2 + templates 3-5; C templates only (no LLM). Judge on A/B,
  custom emails only. Approval refused unless validators and judge both pass (sequences table).
- Grounding is detected by code in each email's text (subjects included), not only the writer's list.
- Page cache and robots.txt answers reused for PAGE_CACHE_DAYS (7). Crawl-delay > 10s skips a site.

## Known open issues
1. Writer quality (live, innercircle, 3 runs): Sonnet with thinking off stacks details (service + city)
   even after the one rewrite, and overstates coverage ("CPA firms are generally covered", "usually").
   Validators catch the stacking; the judge missed the overstatement. Options: adaptive thinking with
   tool_choice auto, drop location from the email-1 input, a second rewrite. Founder to decide.
2. cehcpas decision maker "President/Shareholder" is role_unconfirmed; "president" is not on the list.
3. RBV qualifies via the tax_preparer keyword "tax filing"; confirm that keyword belongs in docs/06.
4. innercircle.cpa answers 403 on /meet-our-team/; each new run requests it once more (per-run rule).
5. Gated leads still get a score and tier; UI must show the gate first.
6. Playwright fallback not built; JS-only pages are recorded as failures.
7. Node 22.14 pins undici 7 and jsdom 29 (newer majors need Node 22.19+/22.22+).
8. opt_out_line and physical_address are empty in docs/01; export stays blocked until set.

## How to run (from repo root)
- Tests: `npm test`  (offline; fixtures + fake network/API)
- Typecheck: `npm run typecheck`
- Smoke (1 tiny live API call): `npm run smoke`
- Live extraction check: `npm run extract-live -- <url> [<url>...] [--refresh] [--record]`
  (batch: fetch all, then extract; `--record` saves regression fixtures). Full reports go to
  data/reports/<lead>.txt; the console shows only the summary.
- Sequence for one lead: `npm run write-sequence -- <url> [--refresh]` -> data/reports/<lead>-sequence.txt
- Dev: `npm run dev:server` (127.0.0.1:8787) and `npm run dev:web` (Vite 5173, proxies /api with token)
- Migrations: `npm run db:generate` after editing apps/server/src/db/schema.ts

## File map
- docs/01,02,03,04,06,08,09 - offer, VERIFIED facts, style, dossier schema, scoring + evidence lists, personas, templates
- prompts/extract.md, write.md, judge.md - system prompts (docs inserted at runtime)
- config/prices.json, skip-patterns.json, mx-providers.json, injection-patterns.json
- packages/shared/src/dossier.ts - model facts vs stored facts, dossier schema, writerView
- packages/shared/src/settings.ts - offer/style/scoring/evidence block schemas
- packages/shared/src/sequence.ts - sequence, writer output, judge output schemas
- apps/server/src/config/env.ts - .env validation
- apps/server/src/llm/client.ts - only API path: count, budget, reserve, backoff, runs log
- apps/server/src/docs/loader.ts, blocks.ts, templates.ts - docs blocks read/write, templates
- apps/server/src/fetch/guarded-fetch.ts, ip-guard.ts, transport.ts - SSRF-safe fetching
- apps/server/src/fetch/robots.ts, rate-limit.ts, clean.ts, select.ts, site.ts - crawl, name hints, 403/429
- apps/server/src/dns/lookup.ts - MX/SPF/DMARC, no_domain_email
- apps/server/src/extract/verify.ts - per-field evidence checks, list search, quote cutting
- apps/server/src/extract/extract.ts, prompt.ts, token-caps.ts, untrusted.ts, caches.ts
- apps/server/src/scoring/score.ts, derive.ts, freshness.ts, contact.ts, security-search.ts
- apps/server/src/pipeline/research.ts - prepare/complete lead, gate, save
- apps/server/src/validators/email.ts - deterministic email checks (DNS remarks, regulatory numbers)
- apps/server/src/write/writer-input.ts, prompt.ts, generate.ts - values-only writer input, grounding
  detection, prompts, tier/gate gating, one rewrite, judge, sequences table, approveSequence
- apps/server/scripts/extract-live.ts, write-sequence.ts, smoke.ts
- apps/server/test/fixtures/live/ - Pease Bell, cehcpas, innercircle, RBV recordings (byte-exact)

## Next: founder review of M4, then M5 UI
Do not start the UI until the founder approves M4. Open decisions: writer quality (issue 1), "president"
in decision_maker_title_preferences, the robots.txt 403 rule, opt_out_line and physical_address.

## Never break
- Every fact: evidence (url + verbatim quote <= 15 words, value inside its quote) or NOT_FOUND; enforced
  in code. services/software items: found in a fetched page's text, with that page's URL.
- No proof claims unless in approved_proof; never claim DKIM status.
- No penalty amounts or dollar figures in prompts, templates, or emails.
- Writer and judge get values only, never evidence quotes or raw page text.
- Honest crawler: ClearPathLeadConsole/0.1 (+CONTACT_URL) user agent, never spoofed; obey robots.txt,
  1 req/s/host, stop on 403/429, SSRF guard on every hop; passive public data only.
- Fetched/pasted text is untrusted data, only in delimited user-message blocks; hidden text never sent.
