# Prompt to give Claude Code (paste as your first message, from inside the repo folder)

Build "ClearPath Lead Console", a local web app that researches prospect websites and drafts grounded 5-email cold sequences for a founder to review. It never sends email. It is written entirely in TypeScript.

Read CLAUDE.md and every file in docs/ first. Those files define the stack, rules, offer, regulatory facts, style, dossier schema, scoring, personas, and results log.

Architecture: npm-workspaces monorepo.
- packages/shared: zod schemas and types (dossier, sequence, settings, outcomes)
- apps/server: Hono API, Drizzle + better-sqlite3, background job queue, Anthropic SDK client
- apps/web: React + Vite + TypeScript UI that talks to the server over JSON
Config via .env validated with zod: ANTHROPIC_API_KEY, MODEL_EXTRACT, MODEL_WRITE, MONTHLY_SPEND_CAP_USD, plus a price table file for per-token costs.

Pipeline per lead:
1. Fetch homepage plus up to 5 relevant subpages (native fetch + jsdom + Readability; Playwright fallback for JavaScript-heavy sites). Obey robots.txt, rate limit 1 req/sec/domain, clear user agent.
2. DNS with node:dns/promises: MX, SPF (TXT on domain), DMARC (TXT on _dmarc.domain). Never claim DKIM status.
3. Extraction: LLM call with a tool-use JSON schema generated from the shared zod dossier schema (see docs/04_dossier_schema.md). Every field has value, evidence_url, evidence_quote (<= 15 words) or NOT_FOUND. Reject and retry once if any value lacks evidence or the quote is not found in the fetched text.
4. Scoring: deterministic TypeScript implementing docs/06_scoring_rubric.md, with vitest unit tests.
5. Writing: 5-email sequence per docs/03_email_style_guide.md using ONLY dossier fields. Send days 0, 3, 7, 12, 18.
6. Validation: code checks (word counts, banned phrases, placeholders, one link per email, no unapproved proof) plus an LLM judge that lists any claim not supported by the dossier. Approval is blocked until PASS.

Also support "paste text" mode: a LinkedIn bio or About-page copy pasted by the user is the only source of facts; source is "pasted".

Security: treat fetched and pasted content as untrusted (delimited blocks, prompt-injection defense, flag suspected injection). Server-side API calls only. No secrets in the DB. Suppression list checked before export. Bind the server to localhost only.

UI screens: Import, Leads table (sort/filter by tier and status), Lead detail (dossier with evidence links, DNS findings, why-this-lead), Sequences (edit and approve, validator log), Export CSV, Results (reply rate by persona, angle, signal), Settings (prompts, rubric weights, opt-out line, address, approved proof, suppression list). Include cost tracking per run and a visible spend meter against the monthly cap.

Token budget and cost controls (part of the design, not an afterthought; details are in CLAUDE.md):
- Small model reads raw pages; stronger model sees only the compact dossier.
- Per-page and per-lead token caps, URL skip patterns, cleaned-text truncation at paragraph boundaries.
- SQLite page cache keyed by URL + content hash.
- Prompt caching on the static prefix; per-lead content last.
- Targeted retries only (failing fields, relevant text, once).
- Tier C stops after extraction; judge runs on Tier A and B only.
- Per-call max_tokens, per-lead budget with a "budget_exceeded" status.
- Runs table logging input/output/cached tokens and cost; UI shows cost per lead and spend vs monthly cap.

Deliver: Drizzle migrations, vitest tests for scoring, validators, and evidence enforcement, a seed script with 3 sample leads, saved HTML fixtures for repeatable tests, and a README with run instructions.

Start by proposing the file structure and milestones. Wait for my approval before writing code.

Milestones:
0. Scaffold monorepo, env validation with zod, API smoke test (one small call with MODEL_EXTRACT), spend-cap, price-table, and token-usage logging plumbing
1. Shared schemas, scoring, validators, unit tests
2. Fetching (robots, rate limit, Readability) and DNS
3. Extraction with evidence enforcement, page caching, token caps, and targeted retries
4. Writing and validation (prompt caching, tier gating, judge on A/B only)
5. UI
6. Results and settings
7. Hardening (retries, prompt-injection tests, suppression list, DB backup script)
