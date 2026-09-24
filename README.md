# ClearPath Lead Console

Local app that researches prospect firms from their public websites, scores them, and drafts
evidence-checked email sequences for review. Runs only on your machine (127.0.0.1).

## Run the app

Requirements: Node 20+ (22 recommended), and a `.env` in the repo root (copy `.env.example`, add your
Anthropic API key and `MONTHLY_SPEND_CAP_USD`). The key stays on the server; the browser never sees it.

```
npm install          # once
npm run app          # starts the API (127.0.0.1:8787) and the UI (127.0.0.1:5173)
```

Open http://127.0.0.1:5173. Ctrl+C stops both. (Or run `npm run dev:server` and `npm run dev:web` in two
terminals.) If the API says the port is in use, the app is already running in another terminal.

Layout: left sidebar navigation, a top bar with the spend meter (month to date vs cap, average per
lead), content in a centered column. Light and dark themes follow the system setting. Works down to
about 900px wide (the sidebar becomes an icon rail).

Screens:
- **Import**: up to 5 website addresses, or paste text (a lead label + pasted text as the only source).
  Live status while it runs; Cancel stops before the next step.
- **Leads**: firm, type, place, score, tier, status, flags, sequence, cost. Sort and filter.
- **Lead detail**: the scorecard (score, tier, one bar per criterion under Fit, Signals, Reachability;
  NOT_FOUND criteria show a gray "unknown" bar), every fact with its source and quote (or NOT_FOUND),
  DNS findings, pages fetched vs failed, the contact card, and "Internal notes: never used in emails".
- **Sequences are template-first.** The copy is yours, in docs/09_sequences.md. The app fills the merge
  fields and the model writes only one sentence, {{personal_line}} in email 1 (one small call per tier A/B
  lead; tier C and any line that fails the code checks use the fallback line from the same file).
- **Contact without a named person** is a warning, never a block. A generic or unattributed inbox shows
  "lower reply odds"; a lead with no public email shows "no public email; add before sending". Email 1
  then opens with the role-based line from docs/09; with a named contact tied to the address it opens
  "Hi <first name>,". The lead page lists optional public sources to find an owner name or email.
- **Sequence**: five email cards, word counts, validators re-run as you type with problems shown on the
  email they belong to, the personal line and the docs/02 approved sentence highlighted (with a legend),
  a preview with the settings filled in, "New personal line" on email 1, Run judge (only needed after
  hand edits), Approve (the reason shows when it is disabled).
- **Export**: approved leads only, in two modes: "Ready to send" (rows with an address) and "Drafts"
  (every approved row). The CSV has send_ready (Y/N) and contact_note columns. Blocked until the
  signature/footer, founding_client_offer, booking_link, and region settings are filled in, and while
  checklist_ready is off. The suppression list is checked before every row.
- **Settings**: signature/footer fields, the merge fields the emails use (founding-client offer, booking
  link, region, company one-liner), checklist ready, DNS remark (saved into docs/01 with a backup in
  data/backups), and the suppression list.

Other commands (from the repo root):
- `npm test` runs every test offline (fixtures and recorded model answers; no network, no API spend).
- `npm run typecheck`
- `npm run screenshots` builds the UI and captures every screen on seed data (offline, no API spend)
  with Playwright into data/screenshots/ (1280px), plus data/screenshots/900/ and data/screenshots/dark/.
  First time only: `npx playwright install chromium`.
- `npm run extract-live -- <url> [...]` and `npm run write-sequence -- <url> [...]` run live research
  from the command line; full reports go to data/reports/.
- `npm run record-personal-lines` records 5 real personal-line generations for the regression test (about
  $0.01; `-- --dry-run` shows the requests without calling the API). Re-record after editing
  prompts/personal_line.md.

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
