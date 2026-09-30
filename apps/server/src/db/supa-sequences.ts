import type { SupabaseClient } from "@supabase/supabase-js";
import type { SequenceStatus } from "../db/schema";

/** The `lead_sequences` table row, in the app's own field names. sequenceJson/validationJson/judgeJson
 * are already-parsed objects (Supabase's jsonb columns come back parsed, not as text), despite the
 * "*Json" name kept from the old SQLite (text) column shape so callers barely change. */
export interface SequenceRecord {
  id: number;
  leadId: string;
  tier: "A" | "B" | "C";
  status: SequenceStatus;
  sequenceJson: unknown;
  validationJson: unknown;
  judgeJson: unknown | null;
  approvedAt: string | null;
  createdAt: string;
}

export interface NewSequenceRecord {
  leadId: string;
  tier: "A" | "B" | "C";
  status: SequenceStatus;
  sequenceJson: unknown;
  validationJson: unknown;
  judgeJson: unknown | null;
}

export interface SequenceRecordPatch {
  sequenceJson?: unknown;
  validationJson?: unknown;
  judgeJson?: unknown | null;
  status?: SequenceStatus;
  approvedAt?: string | null;
}

export interface SequencesDb {
  get(id: number): Promise<SequenceRecord | null>;
  /** All of a lead's sequences, oldest first (matches the old SQLite orderBy(asc(id))). */
  listByLead(leadId: string): Promise<SequenceRecord[]>;
  /** Every sequence, oldest first -- for listSequences' "latest per lead" scan. */
  listAll(): Promise<SequenceRecord[]>;
  /** The id of the lead's newest sequence (approveSequence's "is this still the newest" check). */
  newestIdForLead(leadId: string): Promise<number | null>;
  insert(row: NewSequenceRecord): Promise<number>;
  update(id: number, patch: SequenceRecordPatch): Promise<void>;
}

/** Audit log of manual decisions on a lead (the `lead_events` table): overrides, write attempts. */
export interface EventRecord {
  id: number;
  leadId: string;
  kind: "direct_contact_override" | "gate_override" | "paste_rerun" | "write_attempt";
  detail: string;
  createdAt: string;
}

export interface NewEventRecord {
  leadId: string;
  kind: EventRecord["kind"];
  detail: string;
}

export interface EventsDb {
  listByLead(leadId: string): Promise<EventRecord[]>;
  insert(row: NewEventRecord): Promise<void>;
}

const SEQUENCE_COLUMNS = "id,lead_id,tier,status,sequence,validation,judge,approved_at,created_at";

function fromDbRow(r: Record<string, unknown>): SequenceRecord {
  return {
    id: r.id as number,
    leadId: r.lead_id as string,
    tier: r.tier as "A" | "B" | "C",
    status: r.status as SequenceStatus,
    sequenceJson: r.sequence,
    validationJson: r.validation,
    judgeJson: r.judge ?? null,
    approvedAt: (r.approved_at as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export function realSequencesDb(supa: SupabaseClient): SequencesDb {
  return {
    async get(id) {
      const { data, error } = await supa.from("lead_sequences").select(SEQUENCE_COLUMNS).eq("id", id).maybeSingle();
      if (error) throw new Error(`Could not read sequence ${id}: ${error.message}`);
      return data ? fromDbRow(data) : null;
    },
    async listByLead(leadId) {
      const { data, error } = await supa.from("lead_sequences").select(SEQUENCE_COLUMNS).eq("lead_id", leadId).order("id", { ascending: true });
      if (error) throw new Error(`Could not list sequences for ${leadId}: ${error.message}`);
      return (data ?? []).map(fromDbRow);
    },
    async listAll() {
      const { data, error } = await supa.from("lead_sequences").select(SEQUENCE_COLUMNS).order("id", { ascending: true });
      if (error) throw new Error(`Could not list sequences: ${error.message}`);
      return (data ?? []).map(fromDbRow);
    },
    async newestIdForLead(leadId) {
      const { data, error } = await supa.from("lead_sequences").select("id").eq("lead_id", leadId).order("id", { ascending: false }).limit(1).maybeSingle();
      if (error) throw new Error(`Could not read the newest sequence for ${leadId}: ${error.message}`);
      return (data?.id as number | undefined) ?? null;
    },
    async insert(row) {
      const { data, error } = await supa
        .from("lead_sequences")
        .insert({ lead_id: row.leadId, tier: row.tier, status: row.status, sequence: row.sequenceJson, validation: row.validationJson, judge: row.judgeJson })
        .select("id")
        .single();
      if (error) throw new Error(`Could not save the sequence: ${error.message}`);
      return data.id as number;
    },
    async update(id, patch) {
      const row: Record<string, unknown> = {};
      if ("sequenceJson" in patch) row.sequence = patch.sequenceJson;
      if ("validationJson" in patch) row.validation = patch.validationJson;
      if ("judgeJson" in patch) row.judge = patch.judgeJson;
      if ("status" in patch) row.status = patch.status;
      if ("approvedAt" in patch) row.approved_at = patch.approvedAt;
      const { error } = await supa.from("lead_sequences").update(row).eq("id", id);
      if (error) throw new Error(`Could not update sequence ${id}: ${error.message}`);
    },
  };
}

export function realEventsDb(supa: SupabaseClient): EventsDb {
  return {
    async listByLead(leadId) {
      const { data, error } = await supa.from("lead_events").select("id,lead_id,kind,detail,created_at").eq("lead_id", leadId).order("id", { ascending: true });
      if (error) throw new Error(`Could not read the log for ${leadId}: ${error.message}`);
      return (data ?? []).map((r) => ({ id: r.id as number, leadId: r.lead_id as string, kind: r.kind as EventRecord["kind"], detail: r.detail as string, createdAt: r.created_at as string }));
    },
    async insert(row) {
      const { error } = await supa.from("lead_events").insert({ lead_id: row.leadId, kind: row.kind, detail: row.detail });
      if (error) throw new Error(`Could not log the event: ${error.message}`);
    },
  };
}
