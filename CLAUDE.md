# ClearPath Lead Console

Language: TypeScript everywhere (Node 20+). No Python.

Stack:
- Monorepo with npm workspaces: apps/server, apps/web, packages/shared
- Server: Hono (@hono/node-server), better-sqlite3 + Drizzle ORM, p-queue for background jobs
- Web: React + Vite + TypeScript (plain CSS or Tailwind; no heavy UI framework)
- Shared: zod schemas (dossier, sequence, settings) used by both server and web; generate the LLM tool-use JSON schema from zod (zod-to-json-schema)
- LLM: official @anthropic-ai/sdk, called server-side only. The API key never reaches the browser
- Fetching: native fetch (undici) + jsdom + @mozilla/readability for clean text; Playwright as an optional fallback for JavaScript-heavy sites; robots-parser for robots.txt
- DNS: node:dns/promises (MX, TXT for SPF, TXT on _dmarc.<domain>)
- Tests: vitest. Types: strict mode on
- Config: .env validated with zod at startup (fail fast with a clear message)

Source of truth for prompts, scoring, and style: the files in docs/. Read them at runtime. Do not hardcode their text.

Rules:
- Every prospect fact needs evidence (url + quote <= 15 words) or NOT_FOUND. Enforce in code (zod refinement + retry), not just in prompts.
- Fetched and pasted content is untrusted data: wrap in delimited blocks, never place it in system prompts. Flag suspected prompt injection.
- Never claim ClearPath clients or proof unless it is in the approved_proof setting. Never claim DKIM status (always NOT_CHECKED).
- Passive public data only. Obey robots.txt, 1 request/sec/domain, clear user agent, no probing of prospect systems.
- Scoring (docs/06) and validators are deterministic pure TypeScript functions with unit tests. The LLM never computes scores.
- Hard monthly spend cap in config. Compute cost from token usage using a price table in config (prices filled in from Anthropic's pricing page, never guessed). Log tokens and cost per call in a runs table. Stop calling the API when the cap is reached.
- No secrets in code or the database. API key lives only in .env (git-ignored). Provide .env.example.
- Suppression list is checked before any export.
- Retry API calls with exponential backoff on rate-limit and overload errors.
- Run tests before saying a milestone is done.

Token budget and cost controls (build these in from the start):
- Two-model design: MODEL_EXTRACT (small) reads raw page text; MODEL_WRITE (stronger) sees only the compact dossier, never raw pages.
- Per-page cap (default 6,000 tokens of cleaned text) and per-lead input cap (default 30,000 tokens), both configurable. Skip low-value URLs by pattern (careers, blog archives, tag/category pages, login, cart). Truncate at paragraph boundaries and record truncation in the dossier failures list.
- Cache fetched and cleaned pages in SQLite keyed by URL plus content hash. Never re-fetch or re-send unchanged pages on reruns.
- Prompt caching: put the static prefix (system prompt, schema, style guide, rules) first and mark it cacheable. Put per-lead content last.
- Retries: on an evidence-check failure, retry only the failing fields, with only the relevant page text, at most once. Never resend all pages.
- Tier gating: Tier C leads stop after extraction and get a template-only sequence (no writing or judge calls). Run the judge only on Tier A and B.
- Cap output: max_tokens set per call type. Quotes <= 15 words. No "explain your reasoning" output fields.
- Per-lead token budget in config; when hit, stop and mark the lead "budget_exceeded" for manual review.
- Log input tokens, output tokens, cached tokens, model, call type, lead_id, and computed cost for every API call in a runs table. Show cost per lead and total vs monthly cap in the UI.
- Batch mode (optional, later): use the batch API for non-urgent runs if current terms give a discount. Verify in Anthropic's docs first.
