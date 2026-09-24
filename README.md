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

Screens:
- **Import**: up to 5 website addresses, or paste text (a lead label + pasted text as the only source).
  Live status while it runs; Cancel stops before the next step.
- **Leads**: firm, type, place, score, tier, gate/status, flags, sequence, cost. Sort and filter.
- **Lead detail**: every fact with its evidence link and quote (or a gray NOT_FOUND), DNS findings, score
  breakdown, pages fetched vs failed, the direct-contact checklist and paste form, overrides that need a
  typed reason (logged), and "Internal notes: never used in emails".
- **Sequence**: five editable emails, word counts, validators re-run as you type, code-inserted approved
  sentences highlighted, Run judge, Rewrite one email, Approve (only when validators and judge pass).
- **Export**: approved leads only; blocked until the signature/footer settings are complete (and
  checklist_ready is on if email 3 offers the checklist). The suppression list is checked before every row.
- **Settings**: signature/footer fields (saved into docs/01 with a backup in data/backups) and the
  suppression list.
- The spend meter (month to date vs cap, average per lead) is on every page.

Other commands (from the repo root):
- `npm test` runs every test offline (fixtures and recorded model answers; no network, no API spend).
- `npm run typecheck`
- `npm run extract-live -- <url> [...]` and `npm run write-sequence -- <url> [...]` run live research
  from the command line; full reports go to data/reports/.

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
