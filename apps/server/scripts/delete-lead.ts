/**
 * npm run delete-lead -- <lead_id> [<lead_id> ...] [--yes]
 *
 * Deletes leads: the lead row (its dossier), every sequence, and its event log; cached pages too, but
 * only ones no other lead's dossier still needs (pages is a shared cache keyed by URL). The cost
 * ledger (runs) is never touched, so the monthly spend total stays accurate.
 *
 * Without --yes, this only reports what each id would delete (a firm name, sequence count, pages that
 * would be removed) and changes nothing. Pass --yes to actually delete.
 */
import { eq } from "drizzle-orm";
import { bootstrapOrExit } from "../src/bootstrap";
import { leads, sequences } from "../src/db/schema";
import { deleteLeads } from "../src/pipeline/delete-lead";
import { tryReadStoredDossier } from "../src/pipeline/stored-dossier";
import { isFound } from "@clearpath/shared";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const ids = args.filter((a) => a !== "--yes");

if (ids.length === 0) {
  console.error("Usage: npm run delete-lead -- <lead_id> [<lead_id> ...] [--yes]");
  process.exit(1);
}

const ctx = bootstrapOrExit();
const { db } = ctx;

function describe(id: string): string {
  const row = db.select().from(leads).where(eq(leads.id, id)).get();
  if (!row) return `${id}: not found`;
  const d = row.dossierJson ? tryReadStoredDossier(row.dossierJson) : null;
  const firm = d && isFound(d.firm_name) ? d.firm_name.value : "(no research yet)";
  const seqCount = db.select({ id: sequences.id }).from(sequences).where(eq(sequences.leadId, id)).all().length;
  return `${id}: "${firm}", ${seqCount} sequence(s)`;
}

if (!yes) {
  console.log("Dry run (pass --yes to delete). Would delete:");
  for (const id of ids) console.log(`  ${describe(id)}`);
  process.exit(0);
}

for (const id of ids) console.log(`Deleting ${describe(id)}`);
const result = deleteLeads(db, ids);
const skipped = ids.filter((id) => !result.deleted.includes(id));
console.log(`Deleted ${result.deleted.length} lead(s), ${result.pagesDeleted} cached page(s).`);
if (skipped.length > 0) console.log(`Not found (skipped): ${skipped.join(", ")}`);
