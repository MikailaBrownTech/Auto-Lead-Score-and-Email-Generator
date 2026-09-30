import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The small slice of Supabase's query builder this migration actually uses, behind an interface --
 * so the orchestration logic (runMigration, below) is testable with an in-memory fake, the same way
 * this codebase fakes the Anthropic API, DNS, and fetch elsewhere, rather than needing a live project.
 */
export interface MigrationClient {
  /** Inserts every row; returns the primary key values Supabase assigned/kept, in order. */
  insert(table: string, idColumn: string, rows: Record<string, unknown>[]): Promise<{ ids: unknown[]; error: string | null }>;
  count(table: string): Promise<{ count: number; error: string | null }>;
  deleteByIds(table: string, idColumn: string, ids: unknown[]): Promise<{ error: string | null }>;
}

/** The real adapter, backed by a service-role Supabase client (bypasses RLS). */
export function supabaseMigrationClient(supabase: SupabaseClient): MigrationClient {
  return {
    async insert(table, idColumn, rows) {
      if (rows.length === 0) return { ids: [], error: null };
      const { data, error } = await supabase.from(table).insert(rows).select(idColumn);
      if (error) return { ids: [], error: error.message };
      return { ids: (data ?? []).map((r) => (r as unknown as Record<string, unknown>)[idColumn]), error: null };
    },
    async count(table) {
      const { count, error } = await supabase.from(table).select("*", { count: "exact", head: true });
      if (error) return { count: 0, error: error.message };
      return { count: count ?? 0, error: null };
    },
    async deleteByIds(table, idColumn, ids) {
      if (ids.length === 0) return { error: null };
      const { error } = await supabase.from(table).delete().in(idColumn, ids);
      return { error: error?.message ?? null };
    },
  };
}
