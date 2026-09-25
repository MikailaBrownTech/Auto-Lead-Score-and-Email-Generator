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
- [x] Full AI writer again (2026-09-24, founder decision; replaces template-first for tiers A and B): the
      writer model writes all five emails in the voice of the founder's docs/03 example sequences; code
      splices the VERIFIED docs/02 sentence at [[APPROVED]]; lighter validators; one rewrite from its own
      draft plus the validator errors or judge claims; judge as the second check. Tier C keeps the docs/09
      fixed copy. 5 recorded real generations pass the validator set.
- [ ] M6 Results + settings, M7 Hardening. NEXT (after the founder's tone check of the recordings).

## Current state (2026-09-24, after the full-writer revert)
- Tests: 482 passing in 32 files (vitest: unit, component, offline end-to-end API, UI end-to-end,
  recorded writer generations). Typecheck clean (strict). Web build clean. Month to date about $1.45 of the
  $5 cap. Recording rounds for this change: 5 rounds (about $0.57 total; one round of 5 leads costs about
  $0.15-0.17, about $0.03 per lead: writer, sometimes a rewrite, judge). The last round is what the
  fixtures hold.
- Recorded outcome (last round, real MODEL_WRITE): innercircle, essentialacctg, mapaccountinggroup passed
  on the first draft (validators and judge). rbvfinancial: first draft tied the plan to "EFIN or PTIN
  renewal time" (caught), the rewrite passed the validators, the judge then listed 2 claims (one is a
  false positive on verified services; the other says the "what's usually expected" list is more specific
  than docs/02) -> blocked for review. metaxparma: first draft had over-long subjects (caught); the rewrite
  passed the validators; the judge flagged "this doesn't need to wait until after season" (urgency) ->
  blocked for review. All 5 final drafts pass the reduced validator set (the test's requirement).
- The app runs locally with `npm run app` (API 127.0.0.1:8787 + UI 127.0.0.1:5173). Every screen was
  captured in a real browser (Playwright/Chromium) on seed data: data/screenshots/ (1280px),
  data/screenshots/900/, data/screenshots/dark/. No screen scrolls sideways at 1280 or 900.
- Leads in data/clearpath.db: 7 live leads plus 1 outdated lead (clearpathsecure; import again). Stored
  sequences were written by earlier versions; choose "Write the sequence again" to get the new writer.
- docs/01 (founder, 2026-09-24): company_name "Clear Path Secure", opt_out_line "Click here to opt out",
  physical_address "Cleveland, Ohio", founding_client_offer "Get free security audit", booking_link = the
  contact page, region "Ohio", checklist_ready true. Export is no longer blocked by settings. Before sending:
  commercial email needs a valid postal address (street or PO box), and "Click here to opt out" needs a
  working link or a reply instruction.

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
- Writer (tiers A and B, founder decision 2026-09-24, replacing template-first): MODEL_WRITE writes all
  five emails (forced tool write_sequence {emails: [{n, subject_a, subject_b, body}]}, thinking disabled,
  max_tokens 2500). System prompt (prompts/write.md, cacheable): rules, docs/01 prose, the docs/03 style
  guide, TWO of the three docs/03 example sequences (rotated by a hash of the lead id; one cached prompt
  per pair), docs/08 personas. VERIFIED docs/02 facts are NOT given to the writer. User message: verified
  values only (verifiedValues: firm, type, location, size, services, software, portal; never quotes,
  people, emails, phones), firm type, persona, angle, the greeting rule, sender settings (company,
  one-liner, offer, region; "{{booking_link}}" as a token the app fills), and the approved sentence text.
- The docs/03 examples (founder's text, 3 sequences) had minimal founder-approved fixes: no "Hi there,"
  (B, C), no traction claims ("I do a lot of work with ..." and "I'm working with a small group" became
  "There's a question I've been asking ..." and "I'm taking on a small group ..."), "your own to-do list"
  (banned) and "compliance team" reworded. Their notes and the "What to feed the writer prompt" section
  stay in the file; only the preamble and "## EXAMPLE" sections go to the model.
- Hard rule, in code: the writer never states what a law or rule requires. In email 2 it writes
  [[APPROVED]] on its own line; code replaces it with the exact VERIFIED docs/02 sentence (by writer type:
  cpa insurers at renewal, tax_preparer IRS Pub 4557, others rule requirements), always as its own
  paragraph. A missing marker is a rewrite problem, then repaired by code (inserted before the last
  paragraph); stray markers are removed. The validator fails any other statement (not a question) that
  names a rule, law, or regulator (FTC, Safeguards Rule, GLBA, IRS, EFIN, PTIN, Pub 4557, compliance,
  regulations, law, penalty, fines) or uses an obligation verb (must, required, requires, mandatory).
  "the requirement" (noun), "fine" (okay), "WISP", the firm's name, and its verified service names
  ("IRS Representation") are not claims.
- Lighter validators (founder decision): kept: banned phrases (+ "hi there,"), exclamation/emoji/ALL CAPS
  (words from the firm's name and verified values, and AP/AR, allowed), placeholders, evaluative language
  about the prospect (docs/03 evaluative_terms in a sentence naming the firm or "you're"/"your firm/team/
  site/..."), unapproved proof and traction (proof_patterns + "I work with", "I'm working with", ...;
  the untouched docs/09 fixed copy is exempt), penalty amounts and dollar figures, the regulatory rule
  above, absence claims (negation within 6 words before a plan term), DKIM, DNS unless enabled, links
  (booking_link only), company name, greeting only for a tied contact, generic email 1, subjects (<= 6
  words, firm-name words and region excluded, lowercase), word limits 130/150/110/140/60, footer for export.
  Dropped as rules (now prompt guidance): one question per email, one detail per email; insurer remarks and
  all/every/always are left to the judge.
- Rewrite-on-failure: at most one rewrite. The writer gets the same input, its own draft (as JSON,
  approved sentence as the marker), and the specific problems (validator errors, or the judge's claims
  when the validators passed), and is told to rework the sentences in its own voice. The rewrite wins
  unless it is unusable or has more validator errors than the (repaired) first draft; the judge runs
  again on a rewrite. Max 2 writer + 2 judge calls per write. Still failing -> "blocked", shown in full
  with both drafts' errors for hand editing or "Rewrite this email".
- Judge: MODEL_WRITE, dossier values only plus sender_settings (company, one-liner, offer, region,
  booking link: supported facts about the sender) and the approved sentences. prompts/judge.md no longer
  names the company; general remarks about small firms and hedged hypotheticals are fine.
- Tier C: the docs/09 fixed copy (docs/09 is now only the tier C sequence: the {{personal_line}} slot and
  fallback lines are gone), no writer or judge call. Its settings merge fields ({{offer}}, ...) are filled
  when shown or exported.
- Greeting: a first name only when the public address is tied to that person (and never after a contact
  override); otherwise a role-based opener, never "Hi there,". Code adds a missing "Hi <name>," for a tied
  contact. Emails 2-5 never greet.
- company_one_liner: when empty, the writer is told to describe the company only as in docs/01 (first
  person, never as a track record). An invented default description led to "We do managed IT ...,
  mostly helping ..." in one recording and was removed.
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
  config/dmarc-vendors.json = "possible existing IT provider". Never in the writer input or emails.
- incomplete_data (leads.incomplete_data, ScoreResult.incompleteData): tier below A, data-gap NOT_FOUND
  points would reach the next tier and are at least half the points lost. Score unchanged; report
  recommends paste mode.
- UI (M5): plain React + hash routes, no UI framework. All data goes through the local API; the Vite
  proxy adds the per-process token (written only after the API binds its port). Live validation runs on
  the server (debounced POST /check), so there is one validator implementation. Human edits mark an
  email "edited": it gets the regulatory allowlist (tier C: its original docs/09 copy stays allowed) and
  the judge result is cleared (tied to a content hash). Approve needs validators + judge on the saved text
  (tier C unedited: no judge). "Rewrite this email" (tiers A/B) makes one writer call that sees the whole
  sequence and that email's problems, and replaces only that email. Gate override and contact override
  need a typed reason (>= 10 chars), logged in lead_events.
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
- Models: MODEL_EXTRACT claude-haiku-4-5-20251001 (extraction), MODEL_WRITE claude-sonnet-5 (writer and
  judge; forced tool call, thinking disabled). Prices in config/prices.json (source + date recorded). Cost
  per lead for writing, measured on the recordings: about $0.03 (writer ~7.4k cached prompt tokens + ~0.8k
  input, ~0.9k output; a rewrite reads the cached prompt; judge ~1.4k input).
- Retry: one targeted extraction retry, fixable failures only. Writer: one rewrite (validator errors or
  judge claims).
- DMARC scored only when MX exists (no_domain_email recorded). DNS lookup failures never scored.
- No-WISP points: code keyword search of full page text; needs home + privacy/security page or 3+
  complete pages.
- Freshness: machine-readable dates only; url_date (/YYYY/MM/DD/ path) only when none exist.
- Tiers: A and B: the writer writes all five emails, then the judge. C: the docs/09 fixed copy, no model.
- Word limits (docs/03): email 1 <= 130, 2 <= 150, 3 <= 110, 4 <= 140, 5 <= 60 words. Subjects <= 6
  words, not counting the firm's name (or its words) or region. Bullet lists are allowed; a blank line
  always ends a sentence (so the spliced approved sentence stays whole).
- Grounding is detected by code in each model-written email's text (subjects included).
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
9. Writer recordings: the manual tone check is the founder's (apps/server/test/fixtures/generations/
   <lead>.md). Things noticed while recording: "Wanted to mention this while it's still open" (mild
   urgency, essentialacctg email 4); rbvfinancial mixed "we" and "I" (from the removed default one-liner).
   The judge sometimes flags general remarks or the "what's usually expected" list from the founder's own
   examples; it is a strict second check whose blocks go to the founder.
10. Tension to decide: the docs/03 examples paraphrase "what's usually expected" (written plan, a named
    person, MFA, an incident plan) outside the approved sentence. The validator allows it (no rule named, no
    obligation verb); the judge sometimes flags it as more specific than docs/02. Either add an approved
    docs/02 sentence for that list, or accept judge blocks there.
11. RBV qualifies via the tax_preparer keyword "tax filing"; confirm that keyword belongs in docs/06.
12. innercircle.cpa answers 403 on /meet-our-team/; each new run requests it once more (per-run rule).
13. Gated leads still get a score and tier; UI must show the gate first.
14. Playwright fallback not built; JS-only pages are recorded as failures.
15. Node 22.14 pins undici 7 and jsdom 29 (newer majors need Node 22.19+/22.22+).
16. docs/01 physical_address "Cleveland, Ohio" is not a full postal address, and "Click here to opt out" has
    no link or reply instruction; fix before sending (export no longer blocks on them).
17. Screenshot seed data reuses the smithtax fixture DNS evidence for the added leads (their DNS rows show
    smithtax.example). Seed only; not a product issue.
18. docs/09 (tier C) email 2 lists four expectations outside {{approved_sentence}}; the untouched fixed
    copy is exempt from the regulatory allowlist and the proof check (founder's reviewed wording).
19. include_dns_observation: the writer gets the code-worded DNS remark in its facts only when the setting
    is on; the validators still block DNS mentions otherwise.
20. The absence-claim check is a heuristic (negation within 6 words before a plan term); "No pressure: a
    written plan can wait" would still be flagged.

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
  the report (every writer draft with its errors, the sequence as sent with the approved sentence marked,
  validator log, judge, blockers, tokens, cost) goes to data/reports/<lead>-sequence.txt
- Recorded writer generations: `npm run record-sequences [-- <fixture> ...] [--dry-run]` (real writer +
  judge calls for 5 fixture leads, about $0.15-0.17 a round; --dry-run prints the writer input only) ->
  apps/server/test/fixtures/generations/<lead>.json (every tool answer, the docs/01 settings used) and
  <lead>.md (readable, for the tone check), replayed by test/writer-recorded.test.ts. Runs are logged
  under lead id record-<fixture>; their sequence and event rows are deleted. Re-record after changing
  prompts/write.md or the docs/03 examples.
- Dev: `npm run dev:server` (127.0.0.1:8787) and `npm run dev:web` (Vite 5173, proxies /api with token)
- Migrations: `npm run db:generate` after editing apps/server/src/db/schema.ts

## File map
- docs/01,02,03,04,06,08,09 - offer + settings, VERIFIED facts + approved sentences, style guide + limits +
  the founder's example sequences, dossier schema, scoring + evidence lists, personas, docs/09_sequences.md
  (the tier C fixed copy and the signature block)
- prompts/extract.md, write.md, judge.md - system prompts (docs inserted at runtime)
- config/prices.json, skip-patterns.json, mx-providers.json, injection-patterns.json
- packages/shared/src/dossier.ts - model facts vs stored facts, dossier schema, writerView
- packages/shared/src/settings.ts - offer/style/scoring/evidence block schemas
- packages/shared/src/sequence.ts - sequence, writer tool output ([[APPROVED]] marker), judge output schemas
- apps/server/src/config/env.ts - .env validation
- apps/server/src/llm/client.ts - only API path: count, budget, reserve, backoff, runs log
- apps/server/src/docs/loader.ts, blocks.ts - docs blocks read/write; templates.ts - docs/09 (tier C) parser
- apps/server/src/fetch/guarded-fetch.ts, ip-guard.ts, transport.ts - SSRF-safe fetching
- apps/server/src/fetch/robots.ts, rate-limit.ts, clean.ts, select.ts, site.ts - crawl, name hints, 403/429
- apps/server/src/dns/lookup.ts - MX/SPF/DMARC, no_domain_email
- apps/server/src/extract/verify.ts - per-field evidence checks, list search, quote cutting
- apps/server/src/extract/extract.ts, prompt.ts, token-caps.ts, untrusted.ts, caches.ts
- apps/server/src/scoring/score.ts, derive.ts, freshness.ts, contact.ts, security-search.ts
- apps/server/src/pipeline/research.ts - prepare/complete lead, gate, save
- apps/server/src/validators/email.ts - deterministic email checks (DNS remarks, regulatory numbers)
- apps/server/src/write/writer.ts - writer input, marker splice (buildEmail), write + one rewrite
- apps/server/src/write/prompt.ts - writer/judge prompts, docs/03 examples + rotation, rewrite message
- apps/server/src/write/generate.ts - tier/gate gating, writer + judge, tier C copy, sequences table,
  export blockers, approveSequence
- apps/server/src/write/assemble.ts - tier C: the five emails from docs/09 (greeting, merge fields, swaps)
- apps/server/src/write/merge.ts - firm_short, settings merge fields, signature block
- apps/server/src/write/values.ts - verified values, grounding detection, DNS remark, approved sentence pick
- apps/server/scripts/extract-live.ts, write-sequence.ts, smoke.ts, record-sequences.ts
- apps/server/test/fixtures/generations/ - 5 recorded real writer + judge answers (+ .md for the tone
  check); fixtures/replay.ts replays a recorded live site offline; fixtures/write-deps.ts - test WriteDeps
  over a fake API and a fake writer that answers like a well-behaved model
- apps/server/test/fixtures/live/ - Pease Bell, cehcpas, innercircle, RBV, essentialacctg, metaxparma,
  mapaccountinggroup recordings (byte-exact)
- apps/server/src/scoring/direct-contact.ts - no_named_contact warning, optional checklist, per-lead override
- apps/server/scripts/exit.ts, lead-notes.ts - exit codes; shared report lines
- config/dmarc-vendors.json - DMARC report vendors (not IT providers)
- apps/server/src/server/app.ts - local JSON API (guarded: localhost Host/Origin + per-process token)
- apps/server/src/server/services.ts, jobs.ts, views.ts, export.ts - deps (docs read fresh), p-queue
  jobs, lead/sequence views, export + suppression list
- apps/server/src/write/edit.ts - save/check edits, judge on demand, rewrite one email, sequence state
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
2. Founder: tone check of the 5 recordings (apps/server/test/fixtures/generations/*.md). If the voice
   needs adjusting, edit the docs/03 examples or prompts/write.md, then `npm run record-sequences` and
   `npm test`.
3. Founder: a full postal address and a working opt-out line in Settings before sending.
4. Decide Known issues 10 (the "what's usually expected" list vs the judge).
5. Write every lead's sequence again (stored ones come from earlier versions), review, approve, and do a
   first export (Ready to send, or Drafts for leads with no address).
6. Decisions still open: "tax filing" keyword (Known issues 11), portal link-domain detection (Known issues 3),
   firm_type stability across runs (Known issues 4).
7. M6 Results + settings, then M7 Hardening (persist job status across restarts, a real-browser test,
   Playwright fallback for JS-only sites).

## Never break
- Every fact: evidence (url + verbatim quote <= 15 words, value inside its quote) or NOT_FOUND; enforced
  in code. services/software items: found in a fetched page's text, with that page's URL.
- No proof claims unless in approved_proof; never claim DKIM status.
- No penalty amounts or dollar figures in prompts, templates, or emails.
- The writer and the judge get values only, never evidence quotes or raw page text.
- The writer never states what a law or rule requires: only the exact VERIFIED docs/02 sentence, inserted
  by code at [[APPROVED]]; any other such statement fails the validators.
- Honest crawler: ClearPathLeadConsole/0.1 (+CONTACT_URL) user agent, never spoofed; obey robots.txt,
  1 req/s/host, stop on 403/429, SSRF guard on every hop; passive public data only.
- Fetched/pasted text is untrusted data, only in delimited user-message blocks; hidden text never sent.
