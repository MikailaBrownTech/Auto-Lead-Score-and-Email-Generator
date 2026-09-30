# ClearPath Lead Console

Local app that researches prospect firms from their public websites, scores them, and drafts
evidence-checked email sequences for review. The API only binds to your machine (127.0.0.1); who may
sign in is controlled separately, by Supabase Auth (see below).

## Run the app

Requirements: Node 20+ (22 recommended), and a `.env` in the repo root (copy `.env.example`, add your
Anthropic API key, `MONTHLY_SPEND_CAP_USD`, and the Supabase settings below). The Anthropic key and the
Supabase service role key stay on the server; the browser never sees either.

```
npm install          # once
npm run app          # starts the API (127.0.0.1:8787) and the UI (127.0.0.1:5173)
```

Open http://127.0.0.1:5173. Ctrl+C stops both. (Or run `npm run dev:server` and `npm run dev:web` in two
terminals.) If the API says the port is in use, the app is already running in another terminal.

### Sign in (Supabase Auth)

This app shares one Supabase project with the companion `clearpath-proposal-generator` app (same
`profiles` table, the same owner/staff roles, the same first-signup-becomes-owner rule) -- it never
creates its own separate project or its own parallel role system.

1. Root `.env`: fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (Project
   Settings -> API in the Supabase dashboard). The server won't start without these.
2. `apps/web/.env.local` (copy `apps/web/.env.example`): fill in `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` (the anon key only -- never the service role key here; Vite bundles
   `VITE_`-prefixed vars into the browser).
3. Open the app and create an account. The first account ever created in that Supabase project becomes
   the owner; everyone after starts as staff (promote someone by editing `profiles.role`, same as the
   companion app).

Every screen is behind sign-in; there is no way to reach the app or its API without a valid session.
Auth happens entirely in the browser (`supabase.auth.signInWithPassword/signUp/signOut`, session kept
client-side) -- there's no Next.js middleware or Server Actions layer here to hold it, since this app is
a Vite SPA plus a separate Hono API, not Next.js. The API re-validates the session's bearer token
against Supabase on every request (`apps/server/src/auth/guard.ts`).

Layout: left sidebar navigation, a top bar with the spend meter (month to date vs cap, average per
lead), content in a centered column. Dark only (the ClearPath brand theme). Works down to about 900px
wide (the sidebar becomes an icon rail).

Screens:
- **Import**: up to 5 website addresses, or paste text (a lead label + pasted text as the only source).
  Live status while it runs; Cancel stops before the next step.
- **Leads**: firm, type, place, score, tier, status, flags, sequence, cost. Sort and filter. Select rows
  to delete them in bulk (a confirm step; removes the dossier, sequence, and log, plus any cached page
  tied only to that lead). Lead detail has its own Delete lead button.
- **Lead detail**: a plain-language "Briefing" at the top (fit, contact, services, DMARC/MX security
  posture, WISP mention, site freshness, access notes) — one short line per topic, code-composed with
  no model call from fields already computed; a topic is left out rather than shown with a filler
  sentence when its field is NOT_FOUND or wasn't scored. Wording lives in config/briefing.json, editable
  without a code change. Below it, unchanged: the scorecard (score, tier, one bar per criterion under
  Fit, Signals, Reachability; NOT_FOUND criteria show a gray "unknown" bar), every fact with its source
  and quote (or NOT_FOUND), DNS findings, pages fetched vs failed, the contact card, and "Internal
  notes: never used in emails".
- **Sequences are written by the model, every tier**: all five emails, in the voice of the example
  sequences in docs/03 (which include the app's old fixed copy as one more style example), from the
  lead's verified values only. It never states what a law or rule requires: it marks the spot in email 2
  and the app inserts the exact VERIFIED docs/02 sentence. Code validators run on the draft, a second
  model (the judge) checks for unsupported claims, and the writer gets one rewrite with its own draft and
  the problems found. (Sequences written before this change may still carry the old fixed copy from
  docs/09_sequences.md; that file is now kept for the signature block and that legacy copy.)
- **Contact without a named person** is a warning, never a block. A generic or unattributed inbox shows
  "lower reply odds"; a lead with no public email shows "no public email; add before sending". Email 1
  then opens with a role-based line (never "Hi there,"); with a named contact tied to the address it opens
  "Hi <first name>,". The lead page lists optional public sources to find an owner name or email.
- **Sequence**: five email cards, word counts, validators re-run as you type with problems shown on the
  email they belong to, the docs/02 approved sentence highlighted (with a legend), a preview with the
  settings filled in, the writer's drafts and their errors, "Rewrite this email", Run judge, Approve (the
  reason shows when it is disabled).
- **Export**: approved leads only, in two modes: "Ready to send" (rows with an address) and "Drafts"
  (every approved row). The CSV has send_ready (Y/N) and contact_note columns. Blocked until the
  signature/footer, founding_client_offer, booking_link, and region settings are filled in, and while
  checklist_ready is off. The suppression list is checked before every row.
- **Settings**: signature/footer fields, what the writer is told about you (founding-client offer,
  booking link, region, company one-liner), checklist ready, DNS remark (saved into docs/01 with a backup
  in data/backups), and the suppression list.

Other commands (from the repo root):
- `npm test` runs every test offline (fixtures and recorded model answers; no network, no API spend).
- `npm run typecheck`
- `npm run screenshots` builds the UI and captures every screen on seed data (offline, no API spend)
  with Playwright into data/screenshots/ (1280px), plus data/screenshots/900/ and data/screenshots/dark/.
  First time only: `npx playwright install chromium`.
- `npm run extract-live -- <url> [...]` and `npm run write-sequence -- <url> [...]` run live research
  from the command line; full reports go to data/reports/.
- `npm run record-sequences` records real writer and judge answers for 5 fixture leads (about $0.15-0.20;
  `-- --dry-run` shows the writer's input without calling the API) into
  apps/server/test/fixtures/generations/, with a readable .md per lead for a tone check. Re-record after
  editing prompts/write.md or the docs/03 examples.
- `npm run delete-lead -- <lead_id> [<lead_id> ...] [--yes]` deletes leads from the command line (a
  CLI fallback for the UI's delete buttons). Without `--yes` it only reports what would be deleted.

## Moving to Supabase

The app's operational data still lives in SQLite (`data/clearpath.db`) day to day; only auth has
cut over to Supabase so far. `supabase/migrations/*.sql` adds eight tables to the shared project
(`leads`, `lead_dossiers`, `lead_sequences`, `lead_events`, `candidates`, `runs`, `suppression`,
`settings`) with RLS on every one: operational tables are full read/write for any signed-in user
(matching the companion app's `clients`); `settings` is read for anyone signed in but write-restricted
to an owner (matching how its `plans`/`add_ons` already work). `candidates` is new -- a pre-import
queue, staff can submit a URL or firm name before it becomes a researched lead -- and has no SQLite
source, so the migration script below has nothing to move into it. Apply the migration files to the
Supabase project yourself (same way as the companion app's own migrations) before running the script.

`npm run migrate-to-supabase [-- --sqlite-path <path>] [-- --commit]` reads every row out of SQLite
(read-only; the file is never modified or deleted) and, by default, does a dry run: it inserts
everything into the real Supabase tables via the service role key, prints a source-vs-destination row
count for every table, and then deletes every row it just inserted again, leaving Supabase exactly as
it was. Passing `--commit` inserts the rows for real and leaves them there -- run the dry run first and
check the counts match before doing that. Needs `SUPABASE_SERVICE_ROLE_KEY` in `.env`.

Rewiring the app's own routes/services to read and write Supabase instead of SQLite (the actual
cutover of leads/sequences/etc.) is a separate, larger follow-up, not done yet.

---

## Starter notes (original setup)

WHAT'S HERE
- docs/                      The seven knowledge files (01, 02, 03, 04, 06, 07, 08). There is no file 05; nothing references it.
- CLAUDE.md                  Rules and stack that Claude Code reads every session. Goes in the ROOT of your repo.
- PHASE_C_BUILD_PROMPT.md    The first message to give Claude Code.
- .env.example / .gitignore  Copy into the repo root. Copy .env.example to .env and add your key.
- PROJECT_INSTRUCTIONS.md    Only needed if you also want to try the Claude Project (chat) version first.

BEFORE YOU START
1. Install Node 20+ and Git. (No Python needed.)
2. Fill in the [brackets] in docs/01_offer_and_icp.md.
3. Verify docs/02_regulatory_facts.md against ftc.gov and irs.gov, then mark lines VERIFIED.
4. Create an Anthropic Console account, add a small credit balance, set a monthly spend limit, and create an API key.

SET UP THE REPO
1. mkdir clearpath-lead-console && cd clearpath-lead-console && git init
2. Copy everything from this starter folder into it (docs/, CLAUDE.md, PHASE_C_BUILD_PROMPT.md, .env.example, .gitignore).
3. cp .env.example .env   then put your real key in .env. Never commit .env.
4. Do NOT export ANTHROPIC_API_KEY in your shell (Claude Code may then bill API rates instead of your plan).
5. Open a terminal in the folder, start Claude Code, and paste the contents of PHASE_C_BUILD_PROMPT.md.
6. Approve the plan, then build milestone by milestone. Run the tests after each one.

HOW TO USE (Claude Project, chat version, optional)
1. Create a Project in Claude. Upload the seven files from docs/ as project knowledge.
2. Paste PROJECT_INSTRUCTIONS.md (below its first line) into "Set project instructions".
3. Turn on web search in the chat and use RESEARCH / WRITE / EXPORT commands.
