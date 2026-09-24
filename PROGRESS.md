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
- [x] M4 Writer + judge (no UI), CLI `npm run write-sequence -- <url> [<url>...]`
- [x] M4 review round 1: constrained writer input, regulatory allowlist (docs/02 approved sentences),
      insurer/quantifier/question/evaluation checks, signature block, needs_direct_contact,
      checklist_ready, email 3 wording, report mode with every draft.
- [x] Report-4 fixes (essentialacctg, metaxparma, mapaccountinggroup): exit codes, list cap 25 without
      rejection, firm_type code fallback, true-only model booleans, needs_direct_contact for any lead
      without a person-tied email + per-lead override, url-date filter, staff-only size_signal,
      email_security_hint, incomplete_data; 3 sites recorded as fixtures (7 total).
- [x] M5 UI (local only): Import (URLs or paste, live job status, cancel), Leads table, Lead detail,
      Sequences editor (live validators, judge on demand, rewrite one email, approve gating), Export
      (blocked messages, suppression check, CSV copy/download), minimal Settings + suppression list,
      spend meter on every page.
- [x] Bug fix "Write sequence produces nothing" (commit 524e9bf; see Known issues 1).
- [ ] UI polish: CSS problems reported by the founder (Known issues 2). NEXT.
- [ ] M6 Results + settings, M7 Hardening

## Current state (2026-09-24)
- Last commit before this update: 524e9bf. Working tree clean. Tests: 491 passing in 30 files (vitest:
  unit, component, offline end-to-end API, UI end-to-end import -> Write -> sequence or visible reason).
  Typecheck clean (strict). Web build clean. Month to date about $0.71 of the $5 cap.
- The app runs locally with `npm run app` (API 127.0.0.1:8787 + UI 127.0.0.1:5173). All five M5
  screens plus a Sequences list work against the real API; verified in jsdom and by API calls through
  the Vite proxy, not yet by the founder in a real browser after the bug fix.
- Leads in data/clearpath.db: 7 live leads (4 qualified tier B needing a direct contact, rbvfinancial
  qualified tier B, peasebell and cehcpas out_of_icp) plus 1 outdated lead (clearpathsecure; import again).
  Sequences: innercircle (id 6, passed content, approval blocked by needs_direct_contact) and
  rbvfinancial (id 7, blocked: subject_case validator error, editable in the UI).
- Nothing exports yet: opt_out_line and physical_address are empty, checklist_ready is false, and no
  sequence is approved.

## Bug: "Write sequence" produced nothing (fixed in 524e9bf; details)
- Root cause: the write route and UI click work (reproduced with fixtures and one real write), but
  results were hidden: for gated leads (out_of_icp/needs_review) LeadDetail.tsx disabled the button with
  no reason next to it; server refusals showed only as a small inline span; and generate.ts discarded a
  usable first draft whenever the rewrite came back unusable (the route then returned 409, no sequence).
  The DB showed zero write/judge calls after the UI started, so no click reached the writer.
- Now: every no-sequence path leaves a plain reason on the lead page (lead_events kind write_attempt;
  LeadDetail.notWrittenReason / lastWriteAttempt): gate ("Not written: this lead is out of ICP (...).
  Approve it with a reason to write anyway."), spend cap, budget, broken settings, API errors, job
  failures. Unusable rewrite keeps the first draft (with errors); two unusable answers fall back to the
  template emails, labeled. Tier C / template sequences are labeled "Template (no model call)" and listed
  on the new Sequences screen. The sequence page shows every draft with its errors. All request
  failures show as inline banners (role=alert) with plain wording for 401/403/5xx. Jobs running over
  3 minutes show a "still working" notice.

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
- 403/429 from a prospect site: stop that host for the run, never retry, same UA, paste-text prompt in
  the report. Extraction uses the pages already fetched. INTENTIONAL (founder decision): robots.txt
  answering 403/429 is treated the same way (strict), not as "no robots.txt".
- Writer input is chosen by code: firm name, firm type (qualifying type leads), docs/08 persona, the
  type's first angle, the code greeting, city/state as free context, and exactly one ranked detail for
  emails 1 and 2 (service naming the firm type > other service > software > "a team of N"). Never
  people or dollar figures. City/state does not count as a detail; any other detail is rejected.
- Regulatory content by allowlist: docs/02 `clearpath:regulatory` approved sentences (each restates a
  VERIFIED line; unverified or money/penalty ones are excluded) are inserted verbatim by code into slots
  (email 1 applicability, email 2 one requirement, email 4 checklist). The writer writes only the
  opening and closing around the slot. Writer emails are rejected for any other sentence with
  FTC/Safeguards/IRS/Pub 4557/WISP/penalty/fine/required/must/compliance terms, any insurer assertion
  (questions allowed), and all/every/always/"generally covered". Templates (docs/09) are fixed text,
  exempt from the allowlist but checked by every other validator. The judge is a second layer.
- No thinking, one rewrite at most. Unknown extra keys in writer output are ignored; missing fields fail.
- Every email: at most one question; banned evaluative phrases (docs/03); company name only from docs/01.
- Signature from docs/01: sender_name, sender_title, company_name, company_website, then opt_out_line
  and physical_address (founder fills the last two).
- needs_direct_contact: any lead whose public email is not tied to a named person (generic inbox,
  unattributed, or no email at all). Approval and export blocked until a person-tied address is pasted
  (paste mode, M5), the lead is overridden with a logged reason (overrideDirectContact: reason >= 10
  chars, leads.direct_contact_override_*, lead_events), or docs/01 allow_without_direct_contact is true.
  Overridden leads always get the neutral greeting. Reports print a checklist (paste mode, state
  accountancy board license lookup, Secretary of State business search, Google Business Profile).
- Model booleans (privacy_policy_present, doc_exchange, secure_portal, contact_form) are true (with a
  quote) or NOT_FOUND/null; a model "false" is dropped with a note. Absence is code-only: "no portal"
  comes from the portal keyword search (docs/06 portal_keywords, same page minimum as WISP).
- services/software: model may send any number; code keeps the first 25 found (tool schema max 25).
- firm_type: the model's answer wins when its quote verifies. Otherwise code derives it from docs/06
  firm_type_keywords with its own verbatim quote (source=code): the type the model named is tried first
  (kept only if the code finds a keyword quote for it), else the type with the most hits in verified
  services (x2) and full page text.
- size_signal = people working at the firm; client/company counts go to client_count_signal (not scored).
- url_date freshness ignores /wp-content/uploads/ and non-HTML files; those are never the news page.
- email_security_hint (INTERNAL ONLY): DMARC rua/ruf domains outside the firm's domain and not on
  config/dmarc-vendors.json = "possible existing IT provider". Never in writer input or emails.
- incomplete_data (leads.incomplete_data, ScoreResult.incompleteData): tier below A, data-gap NOT_FOUND
  points would reach the next tier and are at least half the points lost. Score unchanged; report
  recommends paste mode.
- UI (M5): plain React + hash routes, no UI framework. All data goes through the local API; the Vite
  proxy adds the per-process token (written only after the API binds its port). Live validation runs on
  the server (debounced POST /check), so there is one validator implementation. Human edits mark an
  email "edited": it keeps its template status but gets the allowlist and judge like model text (the
  template's own docs/09 sentences stay allowed). Any edit clears approval; the judge result is tied to
  a content hash. Approve needs validators + judge on the saved text + no approval blockers. Gate
  override and direct-contact override need a typed reason (>= 10 chars), logged in lead_events.
- Export: approved leads only; refused as a whole while sender/company/opt-out/address are missing or
  checklist_ready is off with email 3; suppression (email or domain) checked first per row; the CSV has
  only the address, subjects, and rendered emails (never internal notes).
- Exit codes (extract-live, write-sequence): 0 for every expected outcome; 1 only for real errors
  (lead status failed or an uncaught exception), printed as "exit 1 because: ...".
- checklist_ready (docs/01, default false): while false, sequences with email 3 are blocked from export.
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
1. Sequence not generating from the UI ("Write sequence" did nothing). FIXED in 524e9bf, pending the
   founder's check in a real browser. Cause and fix: see the Bug section above. What to watch for: any
   click that ends without a sequence must now show a reason next to the button (gate, spend cap,
   budget, settings, API error, job failure) or a red banner for a failed request. If a click still
   shows nothing, check the lead's Log section (write_attempt events) and the runs table.
2. CSS problems in the UI, reported by the founder. Specifics not yet captured (need a screenshot or a
   description of which screen, window width, and what looks wrong). Suspects from a code review, NOT
   yet confirmed visually:
   a. .app-header has no flex-wrap: title + five nav links + spend meter (min-width 240px) crowd or
      overflow on narrow windows.
   b. Wide tables (Leads: 9 columns; facts, score breakdown) have no overflow-x wrapper, so the page can
      scroll sideways; long URLs and failure lines do not wrap.
   c. Classes used in the JSX with no CSS rule: app, checklist, gate, leads, legend, reason-form, reasons
      (e.g. the reason form and "why Approve is disabled" list are unstyled).
   d. styles.css grew in three appended blocks (M0, M5, banners): duplicated selectors (main, label,
      error colors) and order-dependent overrides; no dark-mode or small-screen rules.
   e. The sticky Sequence toolbar (z-index 1, white background) may cover the approve reasons or banners
      when scrolling.
   Fix plan: reproduce each screen at 1280px and ~900px widths, consolidate styles.css into one ordered
   sheet, add header wrapping and table scroll containers, style the unstyled classes, then add a quick
   visual check (screenshots) before calling it done.
3. Doc-exchange "portal" detection should read link destination domains against a known portal-vendor
    list (e.g. links to sharefile, smartvault, taxdome hosts), not only page words. Not fixed yet.
4. firm_type can change between runs for the same site (essentialacctg: cpa, then bookkeeper). Stabilize
    it later (e.g. keep the previous verified type unless new evidence contradicts it). Not fixed yet.
5. Jobs live in memory: restarting the API forgets job status (leads and sequences are in SQLite).
6. Paste mode (and the lead page's paste form) replaces the lead's facts with the pasted text only.
7. Leads saved by much older versions show as "outdated_research"; import them again.
8. The end-to-end test drives the real API in-process and renders every screen in jsdom; there is no
    real-browser (Playwright) test.
9. innercircle live (after round 1): first pass invalid (6-word subject B; an insurer-flavored sentence),
   the one rewrite passed validators and judge. Subject length is the most common first-pass miss.
10. sender_title "Founder", company_name "ClearPath IT", company_website https://www.clearpathsecure.com
    were filled from docs/01 text and the CTA domain; founder to confirm.
11. RBV qualifies via the tax_preparer keyword "tax filing"; confirm that keyword belongs in docs/06.
12. innercircle.cpa answers 403 on /meet-our-team/; each new run requests it once more (per-run rule).
13. Gated leads still get a score and tier; UI must show the gate first.
14. Playwright fallback not built; JS-only pages are recorded as failures.
15. Node 22.14 pins undici 7 and jsdom 29 (newer majors need Node 22.19+/22.22+).
16. opt_out_line and physical_address are empty in docs/01 (founder will fill); export stays blocked.

## How to run (from repo root)
- The app: `npm run app` -> open http://127.0.0.1:5173 (API on 127.0.0.1:8787; Ctrl+C stops both).
- Tests: `npm test`  (offline; fixtures + fake network/API)
- Typecheck: `npm run typecheck`
- Smoke (1 tiny live API call): `npm run smoke`
- Live extraction check: `npm run extract-live -- <url> [<url>...] [--refresh] [--record]`
  (batch: fetch all, then extract; `--record` saves regression fixtures). Full reports go to
  data/reports/<lead>.txt; the console shows only the summary.
- Sequences: `npm run write-sequence -- <url> [<url>...] [--refresh]` -> one summary line per lead;
  report mode writes every draft (blocked ones too), validator errors, code-inserted approved sentences
  marked apart from model text, judge, blockers, tokens, cost to data/reports/<lead>-sequence.txt
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
- apps/server/test/fixtures/live/ - Pease Bell, cehcpas, innercircle, RBV, essentialacctg, metaxparma,
  mapaccountinggroup recordings (byte-exact)
- apps/server/src/scoring/direct-contact.ts - needs_direct_contact rule, checklist, per-lead override
- apps/server/scripts/exit.ts, lead-notes.ts - exit codes; shared report lines
- config/dmarc-vendors.json - DMARC report vendors (not IT providers)
- apps/server/src/server/app.ts - local JSON API (guarded: localhost Host/Origin + per-process token)
- apps/server/src/server/services.ts, jobs.ts, views.ts, export.ts - deps (docs read fresh), p-queue
  jobs, lead/sequence views, export + suppression list
- apps/server/src/write/edit.ts - save/check edits, judge on demand, rewrite one email, sequence state
- apps/server/src/pipeline/stored-dossier.ts - reads saved dossiers (defaults for newer fields)
- apps/web/src/ - App (hash routes), api.ts, pages/ (Import, Leads, LeadDetail, Sequence + Sequences list, Export,
  Settings), components/ (SpendMeter, ReasonForm, CacheWarnings, ErrorBanner), styles.css (see Known issues 2)
- scripts/dev.mjs - `npm run app` (starts API + UI)

## Next steps
1. Founder: refresh the running app and click "Write sequence" on a qualified lead (e.g. rbvfinancial,
   metaxparma) and on a gated one (peasebell): expect a sequence page or a visible reason. Report
   anything that still shows nothing.
2. Founder: send the CSS problems (screen, window width, screenshot); then fix Known issues 2
   (consolidate styles.css, header wrap, table scroll, unstyled classes) and verify visually.
3. Founder: fill opt_out_line and physical_address in Settings; confirm sender_title, company_name,
   company_website; turn on checklist_ready once the checklist exists.
4. Resolve direct contacts for the 4 needs_direct_contact leads (paste owner name/email, or override
   with a reason), run the judge, approve, and do a first real export.
5. Decisions still open: "tax filing" keyword (Known issues 11), portal link-domain detection (Known issues 3),
   firm_type stability across runs (Known issues 4).
6. M6 Results + settings, then M7 Hardening (persist job status across restarts, a real-browser test,
   Playwright fallback for JS-only sites).

## Never break
- Every fact: evidence (url + verbatim quote <= 15 words, value inside its quote) or NOT_FOUND; enforced
  in code. services/software items: found in a fetched page's text, with that page's URL.
- No proof claims unless in approved_proof; never claim DKIM status.
- No penalty amounts or dollar figures in prompts, templates, or emails.
- Writer and judge get values only, never evidence quotes or raw page text.
- Honest crawler: ClearPathLeadConsole/0.1 (+CONTACT_URL) user agent, never spoofed; obey robots.txt,
  1 req/s/host, stop on 403/429, SSRF guard on every hop; passive public data only.
- Fetched/pasted text is untrusted data, only in delimited user-message blocks; hidden text never sent.
