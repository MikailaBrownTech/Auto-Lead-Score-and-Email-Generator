import type { SupabaseClient } from "@supabase/supabase-js";

export interface SuppressionRecord {
  id: number;
  kind: "email" | "domain";
  value: string;
}

export interface SuppressionDb {
  list(): Promise<SuppressionRecord[]>;
  findByValue(value: string): Promise<SuppressionRecord | null>;
  insert(row: { kind: "email" | "domain"; value: string }): Promise<SuppressionRecord>;
  delete(id: number): Promise<void>;
}

export function realSuppressionDb(supa: SupabaseClient): SuppressionDb {
  return {
    async list() {
      const { data, error } = await supa.from("suppression").select("id,kind,value").order("value", { ascending: true });
      if (error) throw new Error(`Could not read the suppression list: ${error.message}`);
      return (data ?? []) as SuppressionRecord[];
    },
    async findByValue(value) {
      const { data, error } = await supa.from("suppression").select("id,kind,value").eq("value", value).maybeSingle();
      if (error) throw new Error(`Could not check the suppression list: ${error.message}`);
      return (data as SuppressionRecord | null) ?? null;
    },
    async insert(row) {
      const { data, error } = await supa.from("suppression").insert(row).select("id,kind,value").single();
      if (error) throw new Error(`Could not add to the suppression list: ${error.message}`);
      return data as SuppressionRecord;
    },
    async delete(id) {
      const { error } = await supa.from("suppression").delete().eq("id", id);
      if (error) throw new Error(`Could not remove from the suppression list: ${error.message}`);
    },
  };
}
