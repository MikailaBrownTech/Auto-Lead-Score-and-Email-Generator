/**
 * One-time migration: SQLite (data/clearpath.db) -> the new Supabase tables (leads, lead_dossiers,
 * lead_sequences, lead_events, runs, suppression, settings; candidates has no SQLite source, so
 * there is nothing to migrate for it).
 *
 *   npm run migrate-to-supabase [-- --sqlite-path <path>] [-- --commit]
 *
 * Default is a dry run: every row is inserted into the real Supabase tables via the service role key
 * (bypassing RLS), the row counts are reported, and then every row this run just inserted is deleted
 * again, leaving Supabase exactly as it was. This is deliberate: comparing against a destination that
 * was empty the whole time would not actually prove the insert path (field mapping, type conversions,
 * foreign keys) works. Nothing is written to Supabase for good until --commit is passed.
 *
 * The original SQLite file is never written to (only ever opened for read) and is never deleted --
 * it stays as a local backup either way. --sqlite-path lets you point this at a copy of it instead of
 * the live file, if you want that extra bit of caution; reading is safe either way.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env (see .env.example), and the
 * supabase/migrations/*.sql files already applied to the project (same one the companion
 * clearpath-proposal-generator app uses) -- this script only inserts rows, it never creates tables.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createServiceRoleClient } from "../src/auth/supabase";
import { bootstrapOrExit } from "../src/bootstrap";
import { fromRoot } from "../src/config/paths";
import * as schema from "../src/db/schema";
import { loadOffer } from "../src/docs/loader";
import { supabaseMigrationClient } from "../src/migration/client";
import { formatReport, runMigration, type TablePlan } from "../src/migration/run";
import { leadEventRow, leadRows, runRow, sequenceRow, settingsRow, suppressionRow } from "../src/migration/transform";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const sqlitePathArg = args.indexOf("--sqlite-path");
const sqlitePath = sqlitePathArg >= 0 ? args[sqlitePathArg + 1] : undefined;

const ctx = bootstrapOrExit();
const sourcePath = sqlitePath ? fromRoot(sqlitePath) : fromRoot(ctx.env.DB_PATH);
console.log(`Reading (read-only): ${sourcePath}`);
const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
const source = drizzle(sqlite, { schema });

const leadRowsFromSqlite = source.select().from(schema.leads).all();
const leadsPlan = leadRowsFromSqlite.map((l) => leadRows(l));
const validLeadIds = new Set(leadRowsFromSqlite.map((l) => l.id));

const allRuns = source.select().from(schema.runs).all();
const orphanedRunLeadIds = new Set(allRuns.map((r) => r.leadId).filter((id): id is string => !!id && !validLeadIds.has(id)));
if (orphanedRunLeadIds.size > 0) {
  console.log(`Note: ${orphanedRunLeadIds.size} lead id(s) referenced by runs no longer exist (deleted leads, or old record-sequences.ts fixtures); those runs' lead_id migrates as null, same as this app's own delete-lead behavior. Ids: ${[...orphanedRunLeadIds].join(", ")}`);
}

const plans: TablePlan[] = [
  { table: "leads", idColumn: "id", rows: leadsPlan.map((p) => p.lead) },
  { table: "lead_dossiers", idColumn: "lead_id", rows: leadsPlan.map((p) => p.dossier).filter((d): d is Record<string, unknown> => d !== null) },
  { table: "lead_sequences", idColumn: "id", rows: source.select().from(schema.sequences).all().map(sequenceRow) },
  { table: "lead_events", idColumn: "id", rows: source.select().from(schema.leadEvents).all().map(leadEventRow) },
  { table: "runs", idColumn: "id", rows: allRuns.map((r) => runRow(r, validLeadIds)) },
  { table: "suppression", idColumn: "id", rows: source.select().from(schema.suppressions).all().map(suppressionRow) },
  { table: "settings", idColumn: "id", rows: [settingsRow(loadOffer(), ctx.env.MONTHLY_SPEND_CAP_USD)] },
];

sqlite.close();

console.log(commit ? "\n*** --commit: this will permanently write these rows to Supabase. ***\n" : "\nDry run (pass --commit to write for real).\n");
for (const p of plans) console.log(`  ${p.table}: ${p.rows.length} row(s) to migrate`);
console.log();

const supabase = createServiceRoleClient(ctx.env);
const client = supabaseMigrationClient(supabase);
const result = await runMigration(client, plans, { dryRun: !commit });

console.log(formatReport(result));
process.exit(result.hasErrors ? 1 : 0);
