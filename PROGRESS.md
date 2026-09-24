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
- [x] UI feedback round (2026-09-24): contact handling is a warning, not a block (needs_direct_contact
      renamed no_named_contact; neutral_greeting_style; export modes Ready to send / Drafts with
      send_ready + contact_note; "never a generic email 1" validator), and a full CSS redesign (tokens,
      sidebar + top bar layout, scorecard card, email cards, responsive to ~900px, dark theme),
      `npm run screenshots` (Playwright) checked visually at 1280px, 900px, and dark.
- [x] Template-first sequences (2026-09-24): the whole-email writer is gone. docs/09_sequences.md holds the
      founder's copy; code assembles every email; the model writes only {{personal_line}} (one small call per
      tier A/B lead, fallback line otherwise). Greeting rules, merge fields, relaxed word limits, segment
      swaps, export blockers for offer/booking_link/region; 5 recorded real generations pass first time.
- [ ] M6 Results + settings, M7 Hardening. NEXT (after the founder reviews the new sequences).

## Current state (2026-09-24, after the template-first rewrite)
- Tests: 495 passing in 32 files (vitest: unit, component, offline end-to-end API, UI end-to-end,
  recorded personal-line generations). Typecheck clean (strict). Web build clean. Month to date about
  $0.79 of the $5 cap: recording the personal lines took four rounds of 5 calls (about $0.038 total,
  about $0.002 per call) while the prompt was tuned; the last round is what the fixtures hold.
- The app runs locally with `npm run app` (API 127.0.0.1:8787 + UI 127.0.0.1:5173). Every screen was
  captured in a real browser (Playwright/Chromium) on seed data: data/screenshots/ (1280px),
  data/screenshots/900/, data/screenshots/dark/. No screen scrolls sideways at 1280 or 900.
- Leads in data/clearpath.db: 7 live leads (4 qualified tier B labeled no_named_contact, rbvfinancial
  qualified tier B, peasebell and cehcpas out_of_icp) plus 1 outdated lead (clearpathsecure; import
  again). The two stored sequences (innercircle id 6, rbvfinancial id 7) were written by the old
  whole-email writer: they open with "Hi," and use the old copy, so the new validators flag them. Choose
  "Write the sequence again" on each lead to get the docs/09 sequence.
- Nothing exports yet: opt_out_line, physical_address, founding_client_offer, booking_link, and region
  are empty in docs/01; checklist_ready is false; no sequence is approved.

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
- include_dns_observation: docs/01 offer setting, default false. When true: MX required, code-worded
  hedged remark; validators block alarm words, DKIM, and ungrounded DNS mentions.
- Public email: 10 pts when tied to a named person, 5 for generic_inbox or unattributed (docs/06
  partial_points, generic_inbox_prefixes). A generic inbox is never greeted by name.
- Decision maker: 10 pts only when the title is on the preference list; else 5 + role_unconfirmed.
- 403/429 from a prospect site: stop that host for the run, never retry, same UA, paste-text prompt in
  the report. Extraction uses the pages already fetched. INTENTIONAL (founder decision): robots.txt
  answering 403/429 is treated the same way (strict), not as "no robots.txt".
- Template-first (founder decision 2026-09-24): docs/09_sequences.md is the human-written sequence,
  read at runtime as plain Markdown (docs/templates.ts): "## Email N" sections, "Subject A/B:" and
  "Subject (...):" lines, copy up to the {{signature}} line (notes after it are ignored), "Fallback
  personal lines" (per type), "Segment swaps" table, "Signature block". Unknown merge fields refuse the
  file with a plain error. The old whole-email writer, its prompt (prompts/write.md), personas (docs/08
  is no longer read), and the per-email rewrite loop are gone.
- Merge fields: lead fields filled at assembly (firm, firm_short = legal suffixes stripped, city,
  first_name, personal_line, approved_sentence); settings fields filled when shown, checked, or exported
  (company, offer = founding_client_offer, booking_link, region, company_one_liner), so a Settings change
  applies to every sequence without a rewrite. An empty setting stays a visible {{placeholder}} and blocks
  export (not approval). {{approved_sentence}} = the first docs/02 approved sentence for email 2 and the
  segment (cpa: insurers at renewal; tax_preparer: IRS Pub 4557; others: rule requirements), verbatim;
  without one the paragraph is dropped.
- Greeting (docs/09 rules): a first name tied to the public address -> email 1 opens "Hi {{first_name}},"
  and the role-based line is omitted; otherwise (or after a contact override) email 1 opens with the
  role-based line. Emails 2-5 never greet. "Hi there," and docs/01 neutral_greeting_style are gone.
- {{personal_line}}: the only model text. One small call (MODEL_EXTRACT) per tier A/B lead, forced tool
  record_personal_line {personal_line, subject A|B}; max_tokens 200; no thinking. Input: firm name, type,
  city/state, ONE code-chosen service (the first verified service naming the firm type, else the first),
  the segment theme ("emphasize ..."), the copy around the line, and the two subjects. Code checks
  (personal-line.ts): one sentence ending with a period, <= 30 words, 1-2 values from firm/city/service and
  nothing else about the firm, no number outside the firm name or a verified service, no regulatory or
  insurer words outside a verified service name ("IRS Representation" is fine), no evaluative terms
  (docs/03 evaluative_terms) or banned phrases, no absence claim, proof, company name, person's name,
  link, DNS remark, or ALL CAPS. The model's subject pick goes first (both kept for A/B).
- Never a failure the code can repair: tier C, spend cap, budget, API error, unreadable answer, or a line
  that fails the checks -> the docs/09 fallback line for the type (cpa line for other types), with a plain
  note on the sequence page. If the assembled email 1 fails with the model's line, it is rebuilt with the
  fallback. Only a problem in the docs/09 copy or settings can leave a sequence blocked.
- Segments: the lead's primary firm type picks the docs/09 row (cpa, tax_preparer, bookkeeper, payroll);
  any other type uses the cpa row. The row sets email 3's subject and the personal-line theme. The
  sequence's angle tag still follows the primary type (docs/03 firm_type_angles).
- Every email: at most one question mark (the email 1 referral ask was reworded to a statement, founder
  decision); banned phrases; company name only from docs/01 (links are skipped, so a booking link may
  contain it); the firm's own name is exempt from the ALL CAPS and subject case rules.
- Signature: the docs/09 "Signature block" with docs/01 values ({{sender_name}}, "{{sender_title}},
  {{company}}", {{website}}, then {{opt_out_line}} and {{physical_address}}); a line whose fields are all
  empty is left out.
- no_named_contact (was needs_direct_contact; renamed 2026-09-24, migration 0007 renames stored rows):
  any lead whose public email is not tied to a named person (generic inbox, unattributed, or none). A
  WARNING only: tier and score unchanged; drafting, approval, and export all proceed. Badges: "generic
  inbox: lower reply odds", "unattributed inbox: lower reply odds", "no public email" (contactWarning in
  scoring/direct-contact.ts gives the plain text, also used as the CSV contact_note). The lead page keeps
  the public-source checklist as "optional: find an owner name or email to improve reply odds". The
  per-lead override (typed reason >= 10 chars, logged) stays; it only clears the label. The docs/01
  allow_without_direct_contact setting was removed (nothing left to allow).
- "Never a generic email 1" (validator generic_email_1): without a tied first name, email 1 must name the
  firm (full or short) or carry one verified detail outside a greeting line (subjects and the role-based
  line count). With no firm name found ("your firm"), email 1 is blocked.
- Export modes: "Ready to send" = approved rows with a public address; rows without one are listed as
  left out with the note. "Drafts" = every approved row; to_email empty and send_ready N without an
  address. CSV columns lead_id, firm_name, to_email, send_ready, contact_note, subject_a/b (email 1),
  email_n_send_day, email_n_subject (2-5, used when the email starts a new thread), email_n_text. The
  suppression list is checked first in both modes (by domain when there is no address). Addresses and
  names are never guessed or constructed.
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
  config/dmarc-vendors.json = "possible existing IT provider". Never in the personal-line input or emails.
- incomplete_data (leads.incomplete_data, ScoreResult.incompleteData): tier below A, data-gap NOT_FOUND
  points would reach the next tier and are at least half the points lost. Score unchanged; report
  recommends paste mode.
- UI (M5): plain React + hash routes, no UI framework. All data goes through the local API; the Vite
  proxy adds the per-process token (written only after the API binds its port). Live validation runs on
  the server (debounced POST /check), so there is one validator implementation. Human edits mark an
  email "edited": it gets the regulatory allowlist (its original docs/09 copy stays allowed) and needs
  the judge (MODEL_WRITE, on demand). An unedited sequence needs no judge call. Any edit clears approval;
  the judge result is tied to a content hash. Approve needs validators (+ judge when edited) on the saved
  text. "New personal line" (email 1, tiers A/B) makes one small call and rebuilds email 1 from docs/09.
  Gate override and contact override need a typed reason (>= 10 chars), logged in lead_events.
- Export: approved leads only; refused as a whole while sender/company/opt-out/address, founding_client_
  offer, booking_link, or region are empty (or another settings field a sequence uses), or while
  checklist_ready is off (every sequence has email 3); suppression (email or domain) checked first per
  row; the CSV has only the address, contact note, subjects, and rendered emails (never internal notes).
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
- Models: MODEL_EXTRACT claude-haiku-4-5-20251001 (extraction and the personal line), MODEL_WRITE
  claude-sonnet-5 (only the on-demand judge of hand edits; forced tool call, thinking disabled). Prices in
  config/prices.json (source + date recorded). Cost per lead for writing: one personal-line call, about
  $0.002 (measured on the 5 recordings).
- Retry: one targeted extraction retry, fixable failures only. Personal line: no retry (fallback line).
- DMARC scored only when MX exists (no_domain_email recorded). DNS lookup failures never scored.
- No-WISP points: code keyword search of full page text; needs home + privacy/security page or 3+
  complete pages.
- Freshness: machine-readable dates only; url_date (/YYYY/MM/DD/ path) only when none exist.
- Tiers: A and B get the model's personal line (one call); C gets the fallback line (no call). All five
  emails are docs/09 copy for every tier.
- Word limits (docs/03): email 1 <= 130, 2 <= 140, 3 <= 100, 4 <= 130, 5 <= 75 words (the break-up
  sentence count is gone). Subjects <= 6 words, not counting the firm name (full or short) or region
  (founder decision: email 4's subject is 6 words). Bullet lists are allowed (each bullet is one item).
- Grounding is detected by code in email 1's personal line; template copy carries no dossier details.
- Page cache and robots.txt answers reused for PAGE_CACHE_DAYS (7). Crawl-delay > 10s skips a site.

## Known open issues
1. Sequence not generating from the UI ("Write sequence" did nothing). FIXED in 524e9bf. The UI
   end-to-end test and the Playwright screenshots both write sequences through the real UI. Still worth a
   founder click in the live app. If a click shows nothing, check the lead's Log (write_attempt events).
2. CSS redesign DONE (2026-09-24). styles.css replaced by src/styles/{tokens,base,layout,components,
   pages}.css. Tokens: the founder's light/dark values, except success #1b7a44 (the given #1f8a4c was
   4.38:1 on white, below AA); every text/tint pair measured >= 4.5:1 in both themes. Remaining visual
   limits: the CSV preview scrolls sideways inside its own box (by design); no manual theme toggle
   (follows the system setting).
3. Doc-exchange "portal" detection should read link destination domains against a known portal-vendor
    list (e.g. links to sharefile, smartvault, taxdome hosts), not only page words. Not fixed yet.
4. firm_type can change between runs for the same site (essentialacctg: cpa, then bookkeeper). Stabilize
    it later (e.g. keep the previous verified type unless new evidence contradicts it). Not fixed yet.
5. Jobs live in memory: restarting the API forgets job status (leads and sequences are in SQLite).
6. Paste mode (and the lead page's paste form) replaces the lead's facts with the pasted text only.
7. Leads saved by much older versions show as "outdated_research"; import them again.
8. The end-to-end test drives the real API in-process and renders every screen in jsdom; there is no
    real-browser (Playwright) test.
9. Personal-line prompt tuning (recorded): the first prompt produced lines with no value ("your
   bookkeeping work") or three values; giving the model one code-chosen service and "firm name first, then
   the city or the service, not both" made all 5 pass. Lines read a little formulaic ("<firm> handles
   <service>, which means ..."); the founder may want to vary the shape in prompts/personal_line.md.
10. sender_title "Founder", company_name "ClearPath IT", company_website https://www.clearpathsecure.com
    were filled from docs/01 text; founder to confirm. The old cta_url
    (https://www.clearpathsecure.com/contact) was removed with cta_type; booking_link starts empty.
11. RBV qualifies via the tax_preparer keyword "tax filing"; confirm that keyword belongs in docs/06.
12. innercircle.cpa answers 403 on /meet-our-team/; each new run requests it once more (per-run rule).
13. Gated leads still get a score and tier; UI must show the gate first.
14. Playwright fallback not built; JS-only pages are recorded as failures.
15. Node 22.14 pins undici 7 and jsdom 29 (newer majors need Node 22.19+/22.22+).
16. opt_out_line and physical_address are empty in docs/01 (founder will fill); export stays blocked.
17. Screenshot seed data reuses the smithtax fixture DNS evidence for the added leads (their DNS rows show
    smithtax.example). Seed only; not a product issue.
18. docs/09 email 2 lists four expectations ("generally expected to have") outside {{approved_sentence}};
    template copy is exempt from the regulatory allowlist, so this is the founder's own wording. For
    bookkeeper/payroll leads the approved sentence (rule requirements) repeats the same list.
19. include_dns_observation has no slot in docs/09, so no DNS remark appears unless added by hand.
20. {{offer}} is shown as written; a dollar figure there would fail the dollar_amount validator (docs/01:
    no pricing).

## How to run (from repo root)
- The app: `npm run app` -> open http://127.0.0.1:5173 (API on 127.0.0.1:8787; Ctrl+C stops both).
- Screenshots: `npm run screenshots` -> data/screenshots/ (first time: `npx playwright install chromium`)
- Tests: `npm test`  (offline; fixtures + fake network/API)
- Typecheck: `npm run typecheck`
- Smoke (1 tiny live API call): `npm run smoke`
- Live extraction check: `npm run extract-live -- <url> [<url>...] [--refresh] [--record]`
  (batch: fetch all, then extract; `--record` saves regression fixtures). Full reports go to
  data/reports/<lead>.txt; the console shows only the summary.
- Sequences: `npm run write-sequence -- <url> [<url>...] [--refresh]` -> one summary line per lead;
  the report (personal line: model or fallback and why, the sequence as sent, validator log, blockers,
  tokens, cost) goes to data/reports/<lead>-sequence.txt
- Recorded personal lines: `npm run record-personal-lines [-- <fixture> ...] [--dry-run]` (5 real small
  calls, about $0.01; --dry-run prints the requests and makes no call) -> apps/server/test/fixtures/
  generations/, replayed by test/personal-line-recorded.test.ts. Re-record after changing the prompt.
- Dev: `npm run dev:server` (127.0.0.1:8787) and `npm run dev:web` (Vite 5173, proxies /api with token)
- Migrations: `npm run db:generate` after editing apps/server/src/db/schema.ts

## File map
- docs/01,02,03,04,06,09 - offer + settings, VERIFIED facts + approved sentences, style + limits, dossier
  schema, scoring + evidence lists, docs/09_sequences.md (the founder's sequence copy). docs/08 personas are
  no longer read by code.
- prompts/extract.md, personal_line.md, judge.md - system prompts (docs inserted at runtime)
- config/prices.json, skip-patterns.json, mx-providers.json, injection-patterns.json
- packages/shared/src/dossier.ts - model facts vs stored facts, dossier schema, writerView
- packages/shared/src/settings.ts - offer/style/scoring/evidence block schemas
- packages/shared/src/sequence.ts - sequence (email personal_line), personal-line tool output, judge output schemas
- apps/server/src/config/env.ts - .env validation
- apps/server/src/llm/client.ts - only API path: count, budget, reserve, backoff, runs log
- apps/server/src/docs/loader.ts, blocks.ts - docs blocks read/write; templates.ts - docs/09_sequences.md parser
- apps/server/src/fetch/guarded-fetch.ts, ip-guard.ts, transport.ts - SSRF-safe fetching
- apps/server/src/fetch/robots.ts, rate-limit.ts, clean.ts, select.ts, site.ts - crawl, name hints, 403/429
- apps/server/src/dns/lookup.ts - MX/SPF/DMARC, no_domain_email
- apps/server/src/extract/verify.ts - per-field evidence checks, list search, quote cutting
- apps/server/src/extract/extract.ts, prompt.ts, token-caps.ts, untrusted.ts, caches.ts
- apps/server/src/scoring/score.ts, derive.ts, freshness.ts, contact.ts, security-search.ts
- apps/server/src/pipeline/research.ts - prepare/complete lead, gate, save
- apps/server/src/validators/email.ts - deterministic email checks (DNS remarks, regulatory numbers)
- apps/server/src/write/assemble.ts - builds the five emails from docs/09 (greeting, merge fields, swaps)
- apps/server/src/write/merge.ts - firm_short, settings merge fields, signature block
- apps/server/src/write/personal-line.ts - the one model call, its code checks, the fallback
- apps/server/src/write/values.ts - verified values, grounding detection, DNS remark, approved sentence pick
- apps/server/src/write/prompt.ts, generate.ts - prompts; tier/gate gating, repair to fallback, sequences
  table, export blockers, approveSequence
- apps/server/scripts/extract-live.ts, write-sequence.ts, smoke.ts, record-personal-lines.ts
- apps/server/test/fixtures/generations/ - 5 recorded real personal-line generations; fixtures/replay.ts
  replays a recorded live site offline; fixtures/write-deps.ts - test WriteDeps over a fake API
- apps/server/test/fixtures/live/ - Pease Bell, cehcpas, innercircle, RBV, essentialacctg, metaxparma,
  mapaccountinggroup recordings (byte-exact)
- apps/server/src/scoring/direct-contact.ts - no_named_contact warning, optional checklist, per-lead override
- apps/server/scripts/exit.ts, lead-notes.ts - exit codes; shared report lines
- config/dmarc-vendors.json - DMARC report vendors (not IT providers)
- apps/server/src/server/app.ts - local JSON API (guarded: localhost Host/Origin + per-process token)
- apps/server/src/server/services.ts, jobs.ts, views.ts, export.ts - deps (docs read fresh), p-queue
  jobs, lead/sequence views, export + suppression list
- apps/server/src/write/edit.ts - save/check edits, judge on demand (edits), new personal line, sequence state
- apps/server/src/pipeline/stored-dossier.ts - reads saved dossiers (defaults for newer fields)
- apps/web/src/ - App (hash routes, sidebar + top bar), api.ts, pages/ (Import, Leads, LeadDetail, Sequence +
  Sequences list, Export, Settings), components/ (ui.tsx: Icon, Badge, TierChip, StatusBadge, EmptyState,
  Skeleton; Scorecard, SpendMeter, ReasonForm, CacheWarnings, ErrorBanner), styles/ (tokens.css design
  tokens + dark theme, base, layout, components, pages)
- apps/server/scripts/screenshots.ts - `npm run screenshots`: build UI, serve it with the in-process API on
  seed data (test harness), Playwright captures into data/screenshots/ (+ 900/, dark/), sideways-scroll check
- apps/server/test/contact-warning.test.ts - no_named_contact behavior, greetings, generic_email_1, export modes
- scripts/dev.mjs - `npm run app` (starts API + UI)

## Next steps
1. Founder: review data/screenshots/ (and the live app after `npm run app`); report anything that
   still looks wrong with the screen name and window width.
2. Founder: fill opt_out_line, physical_address, founding_client_offer, booking_link, and region in
   Settings; confirm sender_title, company_name, company_website; turn on checklist_ready once the
   checklist exists.
3. Write every lead's sequence again (the stored ones use the old writer), review the personal lines,
   approve, and do a first export (Ready to send, or Drafts for leads with no address).
4. Optional: vary the personal-line shape in prompts/personal_line.md, then re-record
   (`npm run record-personal-lines`) and run `npm test`.
5. Decisions still open: "tax filing" keyword (Known issues 11), portal link-domain detection (Known issues 3),
   firm_type stability across runs (Known issues 4).
6. M6 Results + settings, then M7 Hardening (persist job status across restarts, a real-browser test,
   Playwright fallback for JS-only sites).

## Never break
- Every fact: evidence (url + verbatim quote <= 15 words, value inside its quote) or NOT_FOUND; enforced
  in code. services/software items: found in a fetched page's text, with that page's URL.
- No proof claims unless in approved_proof; never claim DKIM status.
- No penalty amounts or dollar figures in prompts, templates, or emails.
- The personal-line model and the judge get values only, never evidence quotes or raw page text.
- The model writes only {{personal_line}}; everything else is the founder's docs/09 copy or docs/02
  approved sentences, inserted by code.
- Honest crawler: ClearPathLeadConsole/0.1 (+CONTACT_URL) user agent, never spoofed; obey robots.txt,
  1 req/s/host, stop on 403/429, SSRF guard on every hop; passive public data only.
- Fetched/pasted text is untrusted data, only in delimited user-message blocks; hidden text never sent.
