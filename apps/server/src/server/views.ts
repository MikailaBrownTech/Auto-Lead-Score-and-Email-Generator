import { isFound, type Dossier, type LeadDetail, type LeadFlags, type LeadRow, type Sequence, type SequenceListItem, type SequenceView } from "@clearpath/shared";
import { readStoredDossier, tryReadStoredDossier } from "../pipeline/stored-dossier";
import type { EventsDb, SequenceRecord, SequencesDb } from "../db/supa-sequences";
import type { LeadsDb } from "../db/supa-leads";
import type { RunsDb } from "../db/supa-runs";
import { DOCS_DIR, loadScoring } from "../docs/loader";
import { buildBriefing, loadBriefingConfig } from "../pipeline/briefing";
import { contactWarning, lacksNamedContact, leadOverride, namedContactChecklist, publicAddress } from "../scoring/direct-contact";
import { scoreDossier } from "../scoring/score";
import { ALL_EMAIL_NUMBERS, firstNameFor, notWrittenReason, type WriteDeps } from "../write/generate";
import { renderSettings, renderSignature } from "../write/merge";
import { loadSequenceContext, sequenceState } from "../write/edit";
import type { Services } from "./services";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** Total logged spend per lead (from the runs table). */
export function costByLead(runsDb: RunsDb): Promise<Map<string, number>> {
  return runsDb.costByLead();
}

/** Each lead's newest sequence with usable emails (a row without any -- an old unusable draft -- is skipped). */
async function latestSequenceRows(sequencesDb: SequencesDb): Promise<Map<string, SequenceRecord>> {
  const out = new Map<string, SequenceRecord>();
  for (const row of await sequencesDb.listAll()) {
    if (row.sequenceJson != null) out.set(row.leadId, row);
  }
  return out;
}

/** "template": the docs/09 fixed copy (tier C, no model text). "custom": written by the model or edited by hand. */
export function sequenceKind(seq: Sequence): "template" | "custom" {
  return seq.emails.every((e) => e.template && !e.edited && e.personal_line?.source !== "model") ? "template" : "custom";
}

/** The Sequences screen: each lead's newest sequence, templates included. */
export async function listSequences(sequencesDb: SequencesDb, leadsDb: LeadsDb): Promise<SequenceListItem[]> {
  const latest = await latestSequenceRows(sequencesDb);
  const byId = new Map((await leadsDb.list()).map((l) => [l.id, l]));
  const out: SequenceListItem[] = [];
  for (const [leadId, row] of latest) {
    const seq = row.sequenceJson as Sequence;
    const lead = byId.get(leadId);
    const d = lead?.dossierJson ? tryReadStoredDossier(lead.dossierJson) : null;
    out.push({ id: row.id, leadId, firm: d && isFound(d.firm_name) ? d.firm_name.value : null, tier: row.tier, status: row.status, kind: sequenceKind(seq), createdAt: row.createdAt });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function flagsFor(d: Dossier | null, incompleteData: boolean): LeadFlags {
  return {
    generic_inbox: d?.public_email_kind === "generic_inbox",
    unattributed_inbox: d?.public_email_kind === "unattributed",
    no_public_email: d !== null && publicAddress(d) === null,
    incomplete_data: incompleteData,
    declined_automated_access: d?.declined_automated_access === true,
  };
}

export async function listLeads(leadsDb: LeadsDb, sequencesDb: SequencesDb, runsDb: RunsDb): Promise<LeadRow[]> {
  const costs = await costByLead(runsDb);
  const seqs = await latestSequenceRows(sequencesDb);
  const rows = await leadsDb.list();
  return rows
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((l): LeadRow => {
      const d = l.dossierJson ? tryReadStoredDossier(l.dossierJson) : null;
      return {
        id: l.id,
        source: l.source,
        firm: d && isFound(d.firm_name) ? d.firm_name.value : null,
        type: d && isFound(d.firm_type) ? d.firm_type.value.primary : null,
        city: d && isFound(d.location) ? d.location.value.city : null,
        state: d && isFound(d.location) ? d.location.value.state : null,
        score: l.score,
        tier: l.tier,
        gate: l.gateStatus,
        status: l.dossierJson && !d ? "outdated_research" : l.status,
        flags: flagsFor(d, l.incompleteData),
        costUsd: costs.get(l.id) ?? 0,
        sequenceStatus: seqs.get(l.id)?.status ?? null,
        updatedAt: l.updatedAt,
      };
    });
}

export async function leadDetail(s: Services, id: string): Promise<LeadDetail> {
  const l = await s.leadsDb.get(id);
  if (!l?.dossierJson) throw new NotFoundError(`Lead ${id} was not found, or its research has not finished.`);
  const dossier = readStoredDossier(l.dossierJson);
  const docsDir = s.docsDir ?? DOCS_DIR;
  const score = scoreDossier(dossier, loadScoring(docsDir), (s.now ?? (() => new Date()))());
  const briefing = buildBriefing(dossier, score, loadBriefingConfig());
  const override = await leadOverride(s.leadsDb, id);
  const seq = (await latestSequenceRows(s.sequencesDb)).get(id);
  const hint = dossier.email_security_hint;
  const costs = await costByLead(s.runsDb);
  const events = await s.eventsDb.listByLead(id);
  return {
    id,
    source: l.source,
    inputUrl: l.inputUrl,
    status: l.status,
    error: l.error,
    score: score.total,
    tier: score.tier,
    fitPoints: score.fitPoints,
    tierCapped: score.tierCapped,
    gateApproved: l.gateApproved,
    dossier,
    breakdown: score.breakdown.map((b) => ({ key: b.key, label: b.label, group: b.group, points: b.points, max: b.max, reason: b.reason, dataMissing: b.dataMissing })),
    costUsd: costs.get(id) ?? 0,
    flags: flagsFor(dossier, score.incompleteData.flag),
    contact: {
      named: !lacksNamedContact(dossier),
      greeting: firstNameFor(dossier, override) ? `Hi ${firstNameFor(dossier, override)},` : null,
      warning: contactWarning(dossier),
      checklist: lacksNamedContact(dossier) ? namedContactChecklist(dossier) : [],
      override,
    },
    internalNotes: {
      incompleteData: score.incompleteData.flag ? score.incompleteData.reason : null,
      emailSecurityHint: hint === "NOT_FOUND" ? null : hint.note,
      clientCount: isFound(dossier.client_count_signal) ? dossier.client_count_signal.value.text : null,
    },
    events: events.map((e) => ({ kind: e.kind, detail: e.detail, createdAt: e.createdAt })),
    sequenceId: seq?.id ?? null,
    sequenceStatus: seq?.status ?? null,
    notWrittenReason: dossier.gate.status !== "qualified" && !l.gateApproved ? notWrittenReason(dossier.gate) : null,
    lastWriteAttempt: lastAttempt(events, seq?.createdAt ?? null),
    briefing,
  };
}

/** The newest logged write attempt, when it is newer than the lead's current sequence. `events` is oldest-first (EventsDb.listByLead). */
function lastAttempt(events: Awaited<ReturnType<EventsDb["listByLead"]>>, sequenceAt: string | null): { at: string; detail: string } | null {
  let found: { at: string; detail: string } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind === "write_attempt") {
      found = { at: e.createdAt, detail: e.detail };
      break;
    }
  }
  if (!found) return null;
  // Notes are logged after the sequence they describe; an older note belongs to an older attempt.
  if (sequenceAt && found.at < sequenceAt) return null;
  return found;
}

/** The sequence screen's data: content, live validator issues, judge state, blockers, approved sentences. */
export async function sequenceView(sequenceId: number, deps: WriteDeps): Promise<SequenceView> {
  const ctx = await loadSequenceContext(sequenceId, deps);
  const state = sequenceState(ctx, ctx.sequence, ctx.judge, deps);
  return sequenceViewFrom(ctx.id, ctx.leadId, ctx.tier, ctx.dossier, ctx.status === "approved" && state.status === "passed" ? "approved" : state.status, ctx.sequence, state, deps, ctx.drafts);
}

export function sequenceViewFrom(
  id: number,
  leadId: string,
  tier: SequenceView["tier"],
  dossier: Dossier,
  status: string,
  sequence: SequenceView["sequence"],
  state: ReturnType<typeof sequenceState>,
  deps: WriteDeps,
  drafts: SequenceView["drafts"] = [],
): SequenceView {
  return {
    id,
    leadId,
    firm: isFound(dossier.firm_name) ? dossier.firm_name.value : null,
    tier,
    status,
    sequence,
    issues: state.validation.issues,
    validationPass: state.validation.pass,
    judgeRequired: state.judgeRequired,
    judge: state.judge,
    contactWarning: state.contactWarning,
    exportBlockers: state.exportBlockers,
    approvedSentences: deps.approved.map((a) => ({ id: a.id, text: a.text })),
    rewritable: [...ALL_EMAIL_NUMBERS],
    wordLimits: deps.style.word_limits,
    subjectMaxWords: deps.style.subject_max_words,
    signature: renderSignature(deps.templates.signature, deps.offer),
    rendered: sequence.emails.map((e) => ({
      n: e.n,
      subject_a: e.subject_a ? renderSettings(e.subject_a, deps.offer) : null,
      subject_b: e.subject_b ? renderSettings(e.subject_b, deps.offer) : null,
      body: renderSettings(e.body, deps.offer),
    })),
    kind: sequenceKind(sequence),
    drafts,
  };
}
