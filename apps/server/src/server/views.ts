import { isFound, type Dossier, type LeadDetail, type LeadFlags, type LeadRow, type SequenceView } from "@clearpath/shared";
import { readStoredDossier, tryReadStoredDossier } from "../pipeline/stored-dossier";
import { asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, leads, runs, sequences } from "../db/schema";
import { DOCS_DIR, loadScoring } from "../docs/loader";
import { directContactChecklist, directContactReason, lacksDirectContact, leadOverride } from "../scoring/direct-contact";
import { scoreDossier } from "../scoring/score";
import { signatureLines } from "../validators/email";
import { customEmailsFor, type WriteDeps } from "../write/generate";
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

function latestSequences(db: Db): Map<string, { id: number; status: string }> {
  const out = new Map<string, { id: number; status: string }>();
  for (const row of db.select({ id: sequences.id, leadId: sequences.leadId, status: sequences.status }).from(sequences).orderBy(asc(sequences.id)).all()) {
    out.set(row.leadId, { id: row.id, status: row.status });
  }
  return out;
}

function flagsFor(d: Dossier | null, status: string, incompleteData: boolean): LeadFlags {
  return {
    generic_inbox: d?.public_email_kind === "generic_inbox",
    needs_direct_contact: status === "needs_direct_contact",
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
        flags: flagsFor(d, l.status, l.incompleteData),
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
  const score = scoreDossier(dossier, loadScoring(s.docsDir ?? DOCS_DIR), (s.now ?? (() => new Date()))());
  const override = leadOverride(s.db, id);
  const needsContact = lacksDirectContact(dossier) && !override;
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
    breakdown: score.breakdown.map((b) => ({ key: b.key, label: b.label, group: b.group, points: b.points, max: b.max, reason: b.reason })),
    costUsd: costByLead(s.db).get(id) ?? 0,
    flags: flagsFor(dossier, l.status, score.incompleteData.flag),
    directContact: {
      needed: needsContact,
      reason: lacksDirectContact(dossier) ? directContactReason(dossier) : null,
      checklist: lacksDirectContact(dossier) ? directContactChecklist(dossier) : [],
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
  };
}

/** The sequence screen's data: content, live validator issues, judge state, blockers, approved sentences. */
export function sequenceView(db: Db, sequenceId: number, deps: WriteDeps): SequenceView {
  const ctx = loadSequenceContext(db, sequenceId, deps);
  const state = sequenceState(ctx, ctx.sequence, ctx.judge, deps);
  return sequenceViewFrom(ctx.id, ctx.leadId, ctx.tier, ctx.dossier, ctx.status === "approved" && state.status === "passed" ? "approved" : state.status, ctx.sequence, state, deps);
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
    approvalBlockers: state.approvalBlockers,
    exportBlockers: state.exportBlockers,
    approvedSentences: deps.approved.map((a) => ({ id: a.id, text: a.text })),
    rewritable: customEmailsFor(tier),
    wordLimits: deps.style.word_limits,
    breakupSentences: deps.style.breakup_sentences,
    subjectMaxWords: deps.style.subject_max_words,
    signature: signatureLines(deps.offer),
  };
}
