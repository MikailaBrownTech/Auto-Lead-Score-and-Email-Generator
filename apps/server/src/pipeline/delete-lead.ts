import { eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, leads, pages, sequences } from "../db/schema";

export class LeadNotFoundError extends Error {
  override name = "LeadNotFoundError";
}

/** The dossier's `domain` field, read without requiring the full current dossier shape (best-effort). */
function domainOf(dossierJson: string | null): string {
  if (!dossierJson) return "";
  try {
    const d = JSON.parse(dossierJson) as { domain?: unknown };
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
 * Deletes one lead: its row (which holds the dossier), every sequence, and its event log.
 * Also deletes cached pages (the `pages` table) whose domain matches this lead's, but only when no
 * other lead's dossier still has that same domain — `pages` is a shared cache keyed by URL, reused
 * across reruns, so a page is removed only when it is truly tied to this lead alone. `runs` (the cost
 * ledger) and `extractions` (also a shared, content-hash-keyed cache) are left alone: deleting them
 * would corrupt the monthly spend record or throw away cache other leads can still use.
 */
export function deleteLead(db: Db, leadId: string): { pagesDeleted: number } {
  const lead = db.select({ id: leads.id, dossierJson: leads.dossierJson }).from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) throw new LeadNotFoundError(`Lead ${leadId} was not found.`);
  const domain = domainOf(lead.dossierJson);

  db.delete(sequences).where(eq(sequences.leadId, leadId)).run();
  db.delete(leadEvents).where(eq(leadEvents.leadId, leadId)).run();
  db.delete(leads).where(eq(leads.id, leadId)).run();

  let pagesDeleted = 0;
  if (domain) {
    const stillUsed = db
      .select({ dossierJson: leads.dossierJson })
      .from(leads)
      .where(ne(leads.id, leadId))
      .all()
      .some((r) => domainOf(r.dossierJson) === domain);
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
export function deleteLeads(db: Db, leadIds: string[]): { deleted: string[]; pagesDeleted: number } {
  const deleted: string[] = [];
  let pagesDeleted = 0;
  for (const id of leadIds) {
    try {
      pagesDeleted += deleteLead(db, id).pagesDeleted;
      deleted.push(id);
    } catch (err) {
      if (!(err instanceof LeadNotFoundError)) throw err;
    }
  }
  return { deleted, pagesDeleted };
}
