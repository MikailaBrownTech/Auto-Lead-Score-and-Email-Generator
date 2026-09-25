# ClearPath Lead Console: AI Agent Specification (v2)

Status: living document. Supersedes v1. Reflects the removal of the tier-based template/AI split: every qualified lead now receives a fully AI-written sequence, and `docs/09` templates became few-shot style examples rather than literal output. Update this file whenever a prompt, model, or guardrail changes; treat drift between this doc and the code as a bug.

## 1. Purpose and scope

This document specifies every point in the Lead Console where a large language model is called, what it is allowed to decide, what it is never allowed to decide, and how each output is checked before it can reach a human or a prospect. Fetching, DNS, scoring, gates, and the UI are deterministic code and are covered here only where they supply input to, or check the output of, an AI call. Section 8 explains in detail how the "detective work" (DMARC, software, existing IT) is actually done, since none of it is AI.

## 2. Design principle

**The model is used for narrow, checked tasks. Code makes every decision that has legal, financial, or reputational consequence if wrong.**

- The model may extract facts, draft prose, and flag possible problems.
- The model may never assert what the law requires in its own words, decide who is or isn't a target customer, or cause an email to be sent.
- Every model output that becomes visible to a human or a prospect passes through a deterministic check that can reject it, unconditionally, in code.

This principle exists because of specific, observed failures during testing, not as abstract caution: a firm was mistyped based on an unverified model claim; a copyright year was accepted as evidence of a recently updated site; a drafted email asserted "CPA and tax firms are generally covered by the FTC Safeguards Rule" when the source said "many accounting firms," and the AI judge missed it.

## 3. Inventory of AI calls

| # | Name | Model class | Called when | Sees |
|---|---|---|---|---|
| 1 | Extraction | Small (Haiku 4.5) | Once per fetched/pasted lead | Cleaned page text, dossier schema |
| 2 | Writer | Larger (Sonnet 5) | Once per qualified lead, **every tier** | Verified dossier values, settings, few-shot examples (now including former docs/09 templates) |
| 3 | Judge | Larger (Sonnet 5) | Once per drafted sequence, **every tier** | Dossier values, drafted email text |
| 4 | Reply classifier (planned, not yet built) | Small | Once per inbound reply, once sending begins | Reply text, thread history |

**Change from v1:** the tier-based split (Tier C = template-only, zero AI calls) has been removed. Every qualified lead now gets calls 2 and 3, regardless of tier. Gated leads (`out_of_icp`, `needs_review` prior to override) still receive zero AI calls of any kind — this did not change, since it is a fit decision, not a cost-tiering decision.

## 4. Call 1: Extraction

Unchanged from v1. See Section 8 below for a plain-language walkthrough of what this call actually produces and how each fact is sourced, since this is the part that does the "research."

### 4.1 Non-negotiable rules (summary; see v1 for full detail)
1. Every claim must be grounded in an actual quote from a fetched page or pasted text, or the field is `NOT_FOUND`.
2. A quote must genuinely support its value (a support check), not merely exist on the page.
3. The model may only assert a boolean as `true` or `NOT_FOUND` — never `false`. Absence is computed by code, never inferred by the model from a single quote.
4. List fields are verified item-by-item in code.
5. Retries are targeted (one field, one page, once) and never applied to format errors.
6. Deterministic facts (DNS, freshness, firm-name candidates) are computed in code and never asked of the model.
7. Untrusted page content is data, never instruction; suspected prompt injection is flagged and excluded from anything read as a directive.
8. Personal, non-professional details are filtered from stored quotes and never reach the writer.
9. The model only sees pages the pipeline itself fetched under robots.txt, rate-limit, and SSRF rules, or text the user pasted. It cannot browse further on its own.

## 5. Call 2: Writer

### 5.1 Purpose
Draft a complete, natural-sounding sequence for every qualified lead, in ClearPath's voice, using only verified facts. This now applies uniformly across all tiers.

### 5.2 Input
- Dossier values only — never evidence quotes, source URLs, or raw page text (structural, not just a prompting choice)
- Firm type, persona/angle, computed greeting mode — all code-decided
- `docs/01` settings: company one-liner, offer, booking link, signature, opt-out line, address
- Few-shot examples from `docs/03`, now including the former `docs/09` template sequences repurposed as style references (rotated, not copied verbatim)
- The one approved sentence, sourced only from a `VERIFIED` `docs/02` line

### 5.3 Non-negotiable rules
Unchanged from v1: no model-authored regulatory claims (Section 5.3.1 in v1), no unapproved proof claims, no penalty amounts, no evaluation of the prospect, no personal details, code-decided greeting logic, suppression-list check at export.

### 5.4 What changed in v2
- **Every lead now costs one writer call and one judge call**, where lower-fit leads previously cost zero. At your current volume this is a small absolute cost increase (see Section 9) in exchange for consistent quality and no visibly "templated" emails going to any recipient.
- `docs/09` no longer contains literal output text. It is retained as a labeled set of few-shot examples, on the same footing as the Example A/B/C sequences.

## 6. Call 3: Judge

Unchanged in mechanism from v1, now simply invoked for every lead instead of a subset. **Known limitation, restated:** the judge is not a reliable defense against regulatory overstatement (it missed one in testing); that defense is the code-level sentence insertion in Section 5.3, not this call. The judge's proper role is catching stray unsupported claims about the prospect's own specific facts.

## 7. Post-generation validation (code, not AI)

Unchanged from v1. Every writer output — for every lead, every tier — passes the same validator set before approval is possible: approved-sentence presence and exclusivity, banned/evaluative phrases, proof-claim restrictions, no penalty amounts, footer completeness, DNS-observation gating, acronym allowlist. Approval requires both validators and judge to pass, enforced at the data layer.

## 8. How the research actually works (plain language)

This section exists because "run judge" and the research signals (DMARC, software, existing IT) are two different things people tend to conflate. Here is what each one actually is.

### 8.1 "Run judge" — what it means
"Judge" is not a general reviewer or a research step. It is **one specific, narrow API call** (Section 6) that happens *after* a sequence has already been drafted. Its only job is: read the five drafted emails plus the lead's verified facts, and report whether any sentence in the emails claims something the facts don't support. It outputs a pass/fail per email with a list of specific issues, nothing else. It does not touch scoring, does not touch research, and does not decide who to contact. "Running the judge" just means: check this already-written draft before it's allowed to be approved.

### 8.2 DMARC, SPF, MX provider — pure DNS lookups, zero AI
When a lead is researched, the app makes ordinary DNS queries against public DNS infrastructure, the same kind your browser or email client makes constantly, just automated:
- **MX lookup** on the domain: reveals which mail provider they use (Microsoft 365, Google Workspace, or something else), by matching the returned hostname against a lookup table (`config/mx-providers.json`).
- **TXT lookup** on the domain: checks for an SPF record (a line starting `v=spf1`), which is public and always readable.
- **TXT lookup** on `_dmarc.<domain>`: checks for a DMARC record and its policy (`none`, `quarantine`, `reject`, or no record at all).

None of this touches the AI. It's plain code querying public DNS servers and reading the text that comes back. The model never sees or produces any of this data; it's shown in reports purely from `dns/lookup.ts`.

### 8.3 "Software mentioned" — the model reading the page, with evidence required
This one *is* an AI-assisted field, but narrowly: the extraction call (Section 4) reads the cleaned text of the firm's own pages and looks for any software product names the firm itself mentions publicly (e.g., "we use QuickBooks," "powered by Drake Software"). Every item is then checked in code against the actual page text — if the exact phrase isn't found verbatim on the page, the item is dropped. So this is: **the model spots a candidate, code verifies it's really there.** Nothing is inferred or guessed; if a firm's site says nothing about its software, this field is `NOT_FOUND`.

### 8.4 "Already has an existing IT provider" — an inference from DMARC report addresses, not a fact
This is the one signal that's genuinely a judgment call, and it's clearly labeled as such (`email_security_hint`, internal-only, never shown to a prospect). Here's exactly how it's derived:
- The DMARC record (Section 8.2) can include `rua=` and `ruf=` addresses — where the domain owner wants aggregate/forensic security reports sent.
- If that address's domain is **not** the firm's own domain, and **not** a known DMARC monitoring vendor (checked against `config/dmarc-vendors.json`, e.g., dmarcian, Valimail), it's flagged as a *possible* sign that an outside party is already managing some of their email security. Example seen in testing: reports for `mapaccountinggroup.com` were routed to `bob@mynetworkplace.net` — a different domain, not a recognized monitoring vendor — suggesting `mynetworkplace.net` may be their current IT provider.
- This is a **heuristic, not a verified fact.** It could be wrong (a consultant's personal domain, a defunct old vendor). That's exactly why it's kept internal-only and structurally excluded from writer input — it is never allowed to become a claim in an email.

### 8.5 What is NOT researched (no capability exists)
- No probing, scanning, or connecting to a prospect's actual systems, servers, or software. Only public, passive data (their own web pages, and public DNS records) is ever touched.
- No inference of staff size, revenue, or client count beyond what the firm itself states in text the model can quote.
- No social media research, no LinkedIn data, no purchased data of any kind. Every fact in every dossier traces to either a page the tool fetched (with a link back to it) or a DNS record it queried directly.

### 8.6 Summary table

| Signal | How it's actually found | AI involved? |
|---|---|---|
| MX provider (Microsoft 365, Google, etc.) | DNS MX lookup + lookup table | No |
| SPF present | DNS TXT lookup | No |
| DMARC present/policy | DNS TXT lookup on `_dmarc.<domain>` | No |
| "No WISP mention" | Deterministic keyword search over full page text | No |
| Software mentioned | Model spots a candidate; code verifies the exact phrase is on the page | Yes (extraction), code-checked |
| Services, firm type | Model spots a candidate; code verifies against page text / keyword lists | Yes (extraction), code-checked |
| Freshness ("site maintained") | Parsed from `<time>` tags, JSON-LD dates, sitemap `lastmod` | No |
| Possible existing IT provider | Heuristic on DMARC report-address domain vs. known vendor list | No AI; a coded heuristic, internal-only |
| Sequence quality check ("run judge") | LLM reads the draft against the dossier and flags unsupported claims | Yes — this *is* the AI call |

## 9. Cost and token controls

Unchanged mechanism from v1 (small model for extraction, larger for writer/judge, prompt caching, per-lead and monthly spend caps, worst-case reservation reconciled to actual cost). The only material change from v2's removal of tiering: writer + judge calls now happen for every qualified lead rather than a subset, which raises average cost per lead slightly. At current low volume this remains a few cents per lead in aggregate; re-check actual average cost in the runs table after the change ships.

## 10. What "more AI" means going forward

Unchanged from v1: any extension should be a new narrow call with its own explicit input restriction, output contract, and code-level check — never a loosening of what the writer or extractor can decide unsupervised, and never the removal of a validator to let more raw model output through. Any proposal that would let the model assert a regulatory fact in its own words, decide lead eligibility unsupervised, or send an email without human approval remains out of scope regardless of the reason offered.

## 11. Change log

| Date | Change | Reason |
|---|---|---|
| — | Initial specification written | Consolidating rules developed iteratively across Milestones 0-4 |
| — (v2) | Removed tier-based template/AI split; every qualified lead now gets writer + judge calls | User request for consistent AI-written quality across all leads, not just higher tiers |
| — (v2) | Added Section 8, plain-language explanation of DNS/heuristic vs. AI-derived signals | Clarify recurring confusion about what "the AI" is actually doing vs. deterministic code |
