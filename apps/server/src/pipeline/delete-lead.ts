import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { pages } from "../db/schema";
import type { LeadsDb } from "../db/supa-leads";

export class LeadNotFoundError extends Error {
  override name = "LeadNotFoundError";
}

/** The dossier's `domain` field, read without requiring the full current dossier shape (best-effort). Accepts a parsed object (Supabase's jsonb) or a JSON string (legacy). */
function domainOf(dossierJson: unknown): string {
  if (!dossierJson) return "";
  try {
    const d = (typeof dossierJson === "string" ? JSON.parse(dossierJson) : dossierJson) as { domain?: unknown };
    return typeof d.domain === "string" ? d.domain.trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Deletes one lead: its row (which now just references the dossier, sequences, and events; Postgres's
 * own FK constraints cascade those and null out runs.lead_id -- see supabase/migrations).
 * Also deletes cached pages (the SQLite `pages` table, unaffected by the cutover -- still a local
 * cache) whose domain matches this lead's, but only when no other lead's dossier still has that same
 * domain -- `pages` is shared, reused across reruns, so a page is removed only when it is truly tied
 * to this lead alone. `extractions` (also a shared, content-hash-keyed cache) is left alone, same
 * reasoning as before.
 */
export async function deleteLead(db: Db, leadsDb: LeadsDb, leadId: string): Promise<{ pagesDeleted: number }> {
  const lead = await leadsDb.get(leadId);
  if (!lead) throw new LeadNotFoundError(`Lead ${leadId} was not found.`);
  const domain = domainOf(lead.dossierJson);

  await leadsDb.delete(leadId);

  let pagesDeleted = 0;
  if (domain) {
    const others = await leadsDb.list();
    const stillUsed = others.some((r) => r.id !== leadId && domainOf(r.dossierJson) === domain);
    if (!stillUsed) {
      const rows = db.select({ id: pages.id, requestedUrl: pages.requestedUrl, url: pages.url }).from(pages).all();
      const ids = rows.filter((r) => hostnameOf(r.requestedUrl) === domain || hostnameOf(r.url) === domain).map((r) => r.id);
      if (ids.length > 0) {
        for (const id of ids) db.delete(pages).where(eq(pages.id, id)).run();
        pagesDeleted = ids.length;
      }
    }
  }
  return { pagesDeleted };
}

/** Deletes several leads. Ids that no longer exist are skipped rather than failing the whole batch. */
export async function deleteLeads(db: Db, leadsDb: LeadsDb, leadIds: string[]): Promise<{ deleted: string[]; pagesDeleted: number }> {
  const deleted: string[] = [];
  let pagesDeleted = 0;
  for (const id of leadIds) {
    try {
      pagesDeleted += (await deleteLead(db, leadsDb, id)).pagesDeleted;
      deleted.push(id);
    } catch (err) {
      if (!(err instanceof LeadNotFoundError)) throw err;
    }
  }
  return { deleted, pagesDeleted };
}
