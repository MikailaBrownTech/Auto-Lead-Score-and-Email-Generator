import type { RunRowLegacy } from "../db/schema";
import type { leadEventsLegacy, leadsLegacy, sequencesLegacy, suppressionsLegacy } from "../db/schema";
import type { OfferConfig } from "@clearpath/shared";

// Drizzle's inferred row types for the (legacy, SQLite-only) tables this migration reads.
export type SqliteLead = typeof leadsLegacy.$inferSelect;
export type SqliteSequence = typeof sequencesLegacy.$inferSelect;
export type SqliteLeadEvent = typeof leadEventsLegacy.$inferSelect;
export type SqliteSuppression = typeof suppressionsLegacy.$inferSelect;

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/** One SQLite `leads` row -> the Supabase `leads` row, plus its `lead_dossiers` row (if it has research). */
export function leadRows(l: SqliteLead): { lead: Record<string, unknown>; dossier: Record<string, unknown> | null } {
  const lead = {
    id: l.id,
    input_url: l.inputUrl,
    source: l.source,
    status: l.status,
    score: l.score,
    tier: l.tier,
    gate_status: l.gateStatus,
    gate_reasons: parseJson<string[]>(l.gateReasonsJson, []),
    gate_approved: l.gateApproved,
    direct_contact_override_reason: l.directContactOverrideReason,
    direct_contact_override_at: l.directContactOverrideAt,
    incomplete_data: l.incompleteData,
    error: l.error,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
  const dossier = l.dossierJson ? { lead_id: l.id, dossier: JSON.parse(l.dossierJson) as unknown, created_at: l.createdAt, updated_at: l.updatedAt } : null;
  return { lead, dossier };
}

export function sequenceRow(s: SqliteSequence): Record<string, unknown> {
  return {
    id: s.id,
    lead_id: s.leadId,
    tier: s.tier,
    status: s.status,
    sequence: JSON.parse(s.sequenceJson) as unknown,
    validation: JSON.parse(s.validationJson) as unknown,
    judge: s.judgeJson ? (JSON.parse(s.judgeJson) as unknown) : null,
    approved_at: s.approvedAt,
    created_at: s.createdAt,
  };
}

export function leadEventRow(e: SqliteLeadEvent): Record<string, unknown> {
  return { id: e.id, lead_id: e.leadId, kind: e.kind, detail: e.detail, created_at: e.createdAt };
}

/**
 * `runs.lead_id` was never a real foreign key in SQLite, so the cost ledger can (and does) hold rows
 * referencing a lead that no longer exists -- deleted leads (delete-lead.ts deliberately keeps their
 * runs rows: the money was spent either way), or the temporary "record-<fixture>" leads
 * record-sequences.ts cleans up after itself but leaves the runs rows for. Postgres enforces the FK
 * for real, so on migration those references are nulled out here -- the same outcome the schema's own
 * `on delete set null` gives any lead deleted after the migration.
 */
export function runRow(r: RunRowLegacy, validLeadIds: ReadonlySet<string>): Record<string, unknown> {
  return {
    id: r.id,
    created_at: r.createdAt,
    model: r.model,
    call_type: r.callType,
    lead_id: r.leadId && validLeadIds.has(r.leadId) ? r.leadId : null,
    status: r.status,
    input_tokens: r.inputTokens,
    output_tokens: r.outputTokens,
    cache_read_tokens: r.cacheReadTokens,
    cache_write_tokens: r.cacheWriteTokens,
    cache_write_5m_tokens: r.cacheWrite5mTokens,
    cache_write_1h_tokens: r.cacheWrite1hTokens,
    prefix_key: r.prefixKey,
    cost_usd: r.costUsd,
    stop_reason: r.stopReason,
    message_id: r.messageId,
    error: r.error,
  };
}

export function suppressionRow(s: SqliteSuppression): Record<string, unknown> {
  return { id: s.id, kind: s.kind, value: s.value, created_at: s.createdAt };
}

/** docs/01 + the monthly spend cap -> the one-row `settings` table (item 5's "changing spend caps or settings"). */
export function settingsRow(offer: OfferConfig, monthlySpendCapUsd: number): Record<string, unknown> {
  return {
    id: true,
    sender_name: offer.sender_name,
    sender_title: offer.sender_title,
    company_name: offer.company_name,
    company_website: offer.company_website,
    opt_out_line: offer.opt_out_line,
    physical_address: offer.physical_address,
    approved_proof: offer.approved_proof,
    founding_client_offer: offer.founding_client_offer,
    booking_link: offer.booking_link,
    region: offer.region,
    company_one_liner: offer.company_one_liner,
    include_dns_observation: offer.include_dns_observation,
    checklist_ready: offer.checklist_ready,
    monthly_spend_cap_usd: monthlySpendCapUsd,
  };
}
