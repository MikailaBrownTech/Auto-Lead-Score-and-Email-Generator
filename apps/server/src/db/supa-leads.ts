import type { SupabaseClient } from "@supabase/supabase-js";
import type { LeadStatus } from "../db/schema";

/** The `leads` table row, in the app's own field names (camelCase, matching the old SQLite shape). dossierJson, if loaded, is the parsed object from lead_dossiers (not a string - Supabase's jsonb comes back parsed). */
export interface LeadRecord {
  id: string;
  inputUrl: string | null;
  source: "web" | "pasted";
  status: LeadStatus;
  score: number | null;
  tier: "A" | "B" | "C" | null;
  gateStatus: "qualified" | "out_of_icp" | "needs_review" | null;
  gateReasons: string[];
  gateApproved: boolean;
  directContactOverrideReason: string | null;
  directContactOverrideAt: string | null;
  incompleteData: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  dossierJson: unknown | null;
}

export type LeadPatch = Partial<Omit<LeadRecord, "id" | "createdAt" | "updatedAt" | "dossierJson">>;

export interface LeadsDb {
  /** The lead row with its dossier (one round trip: a join via lead_dossiers). Null if it doesn't exist. */
  get(id: string): Promise<LeadRecord | null>;
  list(): Promise<LeadRecord[]>;
  /** Creates the row if it's new, or updates it if it already exists (matches the old onConflictDoUpdate). */
  upsert(id: string, patch: LeadPatch): Promise<void>;
  update(id: string, patch: LeadPatch): Promise<void>;
  /** Updates the lead row and its dossier together (research.ts's one save at the end of a run). */
  saveResearch(id: string, patch: LeadPatch, dossier: unknown): Promise<void>;
  /** Deletes the lead row. Postgres cascades this to lead_dossiers/lead_sequences/lead_events, and
   * sets runs.lead_id to null, on its own (the migrations' FK constraints) -- nothing else to do here. */
  delete(id: string): Promise<void>;
}

const LEAD_COLUMNS = "id,input_url,source,status,score,tier,gate_status,gate_reasons,gate_approved,direct_contact_override_reason,direct_contact_override_at,incomplete_data,error,created_at,updated_at";

function fromDbRow(r: Record<string, unknown>): LeadRecord {
  const dossierRow = r.lead_dossiers as { dossier: unknown }[] | { dossier: unknown } | null | undefined;
  const dossier = Array.isArray(dossierRow) ? (dossierRow[0]?.dossier ?? null) : (dossierRow?.dossier ?? null);
  return {
    id: r.id as string,
    inputUrl: (r.input_url as string | null) ?? null,
    source: r.source as "web" | "pasted",
    status: r.status as LeadStatus,
    score: (r.score as number | null) ?? null,
    tier: (r.tier as "A" | "B" | "C" | null) ?? null,
    gateStatus: (r.gate_status as LeadRecord["gateStatus"]) ?? null,
    gateReasons: (r.gate_reasons as string[] | null) ?? [],
    gateApproved: (r.gate_approved as boolean) ?? false,
    directContactOverrideReason: (r.direct_contact_override_reason as string | null) ?? null,
    directContactOverrideAt: (r.direct_contact_override_at as string | null) ?? null,
    incompleteData: (r.incomplete_data as boolean) ?? false,
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    dossierJson: dossier,
  };
}

function toDbPatch(patch: LeadPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("inputUrl" in patch) out.input_url = patch.inputUrl;
  if ("source" in patch) out.source = patch.source;
  if ("status" in patch) out.status = patch.status;
  if ("score" in patch) out.score = patch.score;
  if ("tier" in patch) out.tier = patch.tier;
  if ("gateStatus" in patch) out.gate_status = patch.gateStatus;
  if ("gateReasons" in patch) out.gate_reasons = patch.gateReasons;
  if ("gateApproved" in patch) out.gate_approved = patch.gateApproved;
  if ("directContactOverrideReason" in patch) out.direct_contact_override_reason = patch.directContactOverrideReason;
  if ("directContactOverrideAt" in patch) out.direct_contact_override_at = patch.directContactOverrideAt;
  if ("incompleteData" in patch) out.incomplete_data = patch.incompleteData;
  if ("error" in patch) out.error = patch.error;
  return out;
}

export function realLeadsDb(supa: SupabaseClient): LeadsDb {
  async function upsertDossier(id: string, dossier: unknown): Promise<void> {
    const { error } = await supa.from("lead_dossiers").upsert({ lead_id: id, dossier }, { onConflict: "lead_id" });
    if (error) throw new Error(`Could not save the dossier: ${error.message}`);
  }

  return {
    async get(id) {
      const { data, error } = await supa.from("leads").select(`${LEAD_COLUMNS},lead_dossiers(dossier)`).eq("id", id).maybeSingle();
      if (error) throw new Error(`Could not read lead ${id}: ${error.message}`);
      return data ? fromDbRow(data) : null;
    },
    async list() {
      const { data, error } = await supa.from("leads").select(`${LEAD_COLUMNS},lead_dossiers(dossier)`);
      if (error) throw new Error(`Could not list leads: ${error.message}`);
      return (data ?? []).map(fromDbRow);
    },
    async upsert(id, patch) {
      const { error } = await supa.from("leads").upsert({ id, ...toDbPatch(patch) }, { onConflict: "id" });
      if (error) throw new Error(`Could not save lead ${id}: ${error.message}`);
    },
    async update(id, patch) {
      const { error } = await supa.from("leads").update(toDbPatch(patch)).eq("id", id);
      if (error) throw new Error(`Could not save lead ${id}: ${error.message}`);
    },
    async saveResearch(id, patch, dossier) {
      const { error } = await supa.from("leads").update(toDbPatch(patch)).eq("id", id);
      if (error) throw new Error(`Could not save lead ${id}: ${error.message}`);
      await upsertDossier(id, dossier);
    },
    async delete(id) {
      const { error } = await supa.from("leads").delete().eq("id", id);
      if (error) throw new Error(`Could not delete lead ${id}: ${error.message}`);
    },
  };
}
