# ClearPath Lead Console: starter files (TypeScript everywhere)

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
