import type { MigrationClient } from "./client";

/** One table's part of the migration. idColumn is the table's own primary key column name. */
export interface TablePlan {
  table: string;
  idColumn: string;
  rows: Record<string, unknown>[];
}

export interface TableResult {
  table: string;
  sourceCount: number;
  /** Rows Supabase reports right after the insert (before any dry-run cleanup). */
  destinationCountAfterInsert: number;
  error: string | null;
}

export interface MigrationResult {
  tables: TableResult[];
  /** True if `--commit` was not passed: everything inserted above was then deleted again. */
  dryRun: boolean;
  /** Any table whose error blocked its insert. Empty means every table's rows were accepted. */
  hasErrors: boolean;
}

/**
 * Inserts every table's rows via `client`, in the given order (leads before lead_dossiers/
 * lead_sequences/lead_events/runs, which reference it by id). In dry-run mode (the default) it then
 * deletes exactly the rows it just inserted, by the ids Supabase handed back, so the destination
 * tables are left exactly as they were -- this still exercises the real insert path (field mapping,
 * type conversions, foreign keys), which comparing against a permanently-empty destination would not.
 */
export async function runMigration(client: MigrationClient, plans: TablePlan[], opts: { dryRun: boolean }): Promise<MigrationResult> {
  const tables: TableResult[] = [];
  const insertedIds = new Map<string, unknown[]>();
  let hasErrors = false;

  for (const plan of plans) {
    const { ids, error } = await client.insert(plan.table, plan.idColumn, plan.rows);
    if (error) hasErrors = true;
    insertedIds.set(plan.table, ids);
    const { count } = await client.count(plan.table);
    tables.push({ table: plan.table, sourceCount: plan.rows.length, destinationCountAfterInsert: count, error });
  }

  if (opts.dryRun) {
    // Clean up in reverse order, so a child row referencing a parent by foreign key is removed first.
    for (const plan of [...plans].reverse()) {
      const ids = insertedIds.get(plan.table) ?? [];
      const { error } = await client.deleteByIds(plan.table, plan.idColumn, ids);
      if (error) hasErrors = true;
    }
  }

  return { tables, dryRun: opts.dryRun, hasErrors };
}

/** A plain-text table: source count vs. what Supabase reported right after the insert. */
export function formatReport(result: MigrationResult): string {
  const rows = result.tables.map((t) => {
    const match = t.error ? "ERROR" : t.sourceCount === t.destinationCountAfterInsert ? "match" : "MISMATCH";
    return { table: t.table, source: String(t.sourceCount), destination: String(t.destinationCountAfterInsert), match, detail: t.error ?? "" };
  });
  const widths = {
    table: Math.max(5, ...rows.map((r) => r.table.length)),
    source: Math.max(6, ...rows.map((r) => r.source.length)),
    destination: Math.max(11, ...rows.map((r) => r.destination.length)),
  };
  const pad = (s: string, w: number) => s.padEnd(w);
  const lines = [
    `${pad("table", widths.table)}  ${pad("source", widths.source)}  ${pad("destination", widths.destination)}  result`,
    ...rows.map((r) => `${pad(r.table, widths.table)}  ${pad(r.source, widths.source)}  ${pad(r.destination, widths.destination)}  ${r.match}${r.detail ? ` (${r.detail})` : ""}`),
  ];
  const mode = result.dryRun ? "DRY RUN -- every row above was inserted, counted, then deleted again. Nothing was left in Supabase." : "COMMITTED -- these rows are now permanent in Supabase.";
  const verdict = result.hasErrors
    ? "Some tables had errors; nothing below \"match\" should be trusted until they're fixed."
    : result.tables.every((t) => t.sourceCount === t.destinationCountAfterInsert)
      ? "Every table's row count matched. Nothing was dropped."
      : "At least one table's count did not match. Do not run --commit until this is understood.";
  return [mode, "", lines.join("\n"), "", verdict].join("\n");
}
