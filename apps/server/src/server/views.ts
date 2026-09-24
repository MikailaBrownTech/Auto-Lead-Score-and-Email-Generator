import { isFound, type Dossier, type LeadDetail, type LeadFlags, type LeadRow, type Sequence, type SequenceListItem, type SequenceView } from "@clearpath/shared";
import { readStoredDossier, tryReadStoredDossier } from "../pipeline/stored-dossier";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, leads, runs, sequences } from "../db/schema";
import { DOCS_DIR, loadScoring } from "../docs/loader";
import { contactWarning, lacksNamedContact, leadOverride, namedContactChecklist, publicAddress } from "../scoring/direct-contact";
import { scoreDossier } from "../scoring/score";
import { firstNameFor, modelEmailsFor, notWrittenReason, type WriteDeps } from "../write/generate";
import { renderSettings, renderSignature } from "../write/merge";
import { loadSequenceContext, sequenceState } from "../write/edit";
import type { Services } from "./services";

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** Total logged spend per lead (from the runs table). */
export function costByLead(db: Db): Map<string, number> {
  const rows = db
    .select({ leadId: runs.leadId, cost: sql<number>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .groupBy(runs.leadId)
    .all();
  return new Map(rows.filter((r) => r.leadId).map((r) => [r.leadId!, r.cost]));
}

function latestSequences(db: Db): Map<string, { id: number; status: string; createdAt: string }> {
  const out = new Map<string, { id: number; status: string; createdAt: string }>();
  for (const row of db
    .select({ id: sequences.id, leadId: sequences.leadId, status: sequences.status, createdAt: sequences.createdAt, json: sequences.sequenceJson })
    .from(sequences)
    .orderBy(asc(sequences.id))
    .all()) {
    // A row without usable emails (an old unusable draft) is not a sequence to open.
    if (row.json && row.json !== "null") out.set(row.leadId, { id: row.id, status: row.status, createdAt: row.createdAt });
  }
  return out;
}

/** "template": docs/09 copy and a fallback personal line (no model text). "custom": a model-written line or hand edits. */
export function sequenceKind(seq: Sequence): "template" | "custom" {
  return seq.emails.every((e) => e.template && !e.edited && e.personal_line?.source !== "model") ? "template" : "custom";
}

/** The Sequences screen: each lead's newest sequence, templates included. */
export function listSequences(db: Db): SequenceListItem[] {
  const latest = latestSequences(db);
  const out: SequenceListItem[] = [];
  for (const [leadId, s] of latest) {
    const row = db.select().from(sequences).where(eq(sequences.id, s.id)).get()!;
    const seq = JSON.parse(row.sequenceJson) as Sequence;
    const lead = db.select({ dossierJson: leads.dossierJson }).from(leads).where(eq(leads.id, leadId)).get();
    const d = lead?.dossierJson ? tryReadStoredDossier(lead.dossierJson) : null;
    out.push({ id: s.id, leadId, firm: d && isFound(d.firm_name) ? d.firm_name.value : null, tier: row.tier, status: row.status, kind: sequenceKind(seq), createdAt: row.createdAt });
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

export function listLeads(db: Db): LeadRow[] {
  const costs = costByLead(db);
  const seqs = latestSequences(db);
  return db
    .select()
    .from(leads)
    .orderBy(desc(leads.updatedAt))
    .all()
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

export function leadDetail(s: Services, id: string): LeadDetail {
  const l = s.db.select().from(leads).where(eq(leads.id, id)).get();
  if (!l?.dossierJson) throw new NotFoundError(`Lead ${id} was not found, or its research has not finished.`);
  const dossier = readStoredDossier(l.dossierJson);
  const docsDir = s.docsDir ?? DOCS_DIR;
  const score = scoreDossier(dossier, loadScoring(docsDir), (s.now ?? (() => new Date()))());
  const override = leadOverride(s.db, id);
  const seq = latestSequences(s.db).get(id);
  const hint = dossier.email_security_hint;
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
    costUsd: costByLead(s.db).get(id) ?? 0,
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
    events: s.db
      .select({ kind: leadEvents.kind, detail: leadEvents.detail, createdAt: leadEvents.createdAt })
      .from(leadEvents)
      .where(eq(leadEvents.leadId, id))
      .orderBy(asc(leadEvents.id))
      .all(),
    sequenceId: seq?.id ?? null,
    sequenceStatus: seq?.status ?? null,
    notWrittenReason: dossier.gate.status !== "qualified" && !l.gateApproved ? notWrittenReason(dossier.gate) : null,
    lastWriteAttempt: lastAttempt(s.db, id, seq?.createdAt ?? null),
  };
}

/** The newest logged write attempt, when it is newer than the lead's current sequence. */
function lastAttempt(db: Db, leadId: string, sequenceAt: string | null): { at: string; detail: string } | null {
  const e = db
    .select({ at: leadEvents.createdAt, detail: leadEvents.detail })
    .from(leadEvents)
    .where(and(eq(leadEvents.leadId, leadId), eq(leadEvents.kind, "write_attempt")))
    .orderBy(desc(leadEvents.id))
    .limit(1)
    .get();
  if (!e) return null;
  // Notes are logged after the sequence they describe; an older note belongs to an older attempt.
  if (sequenceAt && e.at < sequenceAt) return null;
  return e;
}

/** The sequence screen's data: content, live validator issues, judge state, blockers, approved sentences. */
export function sequenceView(db: Db, sequenceId: number, deps: WriteDeps): SequenceView {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const state = sequenceState(ctx, ctx.sequence, ctx.judge, deps);
  return sequenceViewFrom(ctx.id, ctx.leadId, ctx.tier, ctx.dossier, ctx.status === "approved" && state.status === "passed" ? "approved" : state.status, ctx.sequence, state, deps, ctx.personalLine);
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
  line: SequenceContextLine = null,
): SequenceView {
  const e1 = sequence.emails[0];
  const current = e1?.personal_line ?? null;
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
    rewritable: modelEmailsFor(tier),
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
    personalLine: current ? { ...current, note: current.source === "fallback" && line?.line.text === current.text ? line.note : current.source === "fallback" ? "the docs/09 fallback line is used" : null } : null,
  };
}

type SequenceContextLine = ReturnType<typeof loadSequenceContext>["personalLine"];
