import { isFound, type Dossier, type OfferConfig } from "@clearpath/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, leads } from "../db/schema";

/** A per-lead override of needs_direct_contact, with the reason the founder gave. */
export interface DirectContactOverride {
  reason: string;
  at: string;
}

/** A lead without a person-tied public address: a generic inbox, an unattributed address, or none. */
export function lacksDirectContact(d: Dossier): boolean {
  return d.public_email_kind !== "named_person";
}

/** Why the lead lacks a direct contact, in words for the report and blockers. */
export function directContactReason(d: Dossier): string {
  const address = isFound(d.public_contact_email) ? d.public_contact_email.value.address : null;
  if (!address) return "no public email address was found";
  if (d.public_email_kind === "generic_inbox") return `${address} is a generic inbox`;
  return `${address} is not tied to a named person`;
}

/**
 * needs_direct_contact blocks approval and export unless the global setting
 * (allow_without_direct_contact) or a per-lead override with a logged reason allows it.
 */
export function directContactBlockers(d: Dossier, offer: OfferConfig, override: DirectContactOverride | null): string[] {
  if (!lacksDirectContact(d) || offer.allow_without_direct_contact || override) return [];
  return [
    `needs_direct_contact: ${directContactReason(d)}; paste the owner's name and email (paste mode), override this lead with a reason, or set allow_without_direct_contact in docs/01`,
  ];
}

/** What to do for a needs_direct_contact lead (shown in reports and the UI). */
export function directContactChecklist(d: Dossier): string[] {
  const state = isFound(d.location) ? d.location.value.state : null;
  const firm = isFound(d.firm_name) ? d.firm_name.value : "the firm";
  return [
    `[ ] Paste the owner's name and email via paste mode (${directContactReason(d)}).`,
    `[ ] State accountancy board license lookup${state ? ` (${state})` : ""}: search ${firm} or its owner for the licensee name.`,
    `[ ] Secretary of State business search${state ? ` (${state})` : ""}: registered agent and officers for ${firm}.`,
    `[ ] Google Business Profile for ${firm}: owner name, and whether a direct email is listed.`,
    "[ ] Solo practice whose only address is the owner's inbox: override this lead with a reason (emails then use the neutral greeting).",
  ];
}

export function leadOverride(db: Db, leadId: string): DirectContactOverride | null {
  const row = db
    .select({ reason: leads.directContactOverrideReason, at: leads.directContactOverrideAt })
    .from(leads)
    .where(eq(leads.id, leadId))
    .get();
  return row?.reason && row.at ? { reason: row.reason, at: row.at } : null;
}

/** Minimum length of an override reason, so the log says something useful. */
export const MIN_OVERRIDE_REASON = 10;

/**
 * Overrides needs_direct_contact for one lead (e.g. a solo practice whose only address is the
 * owner's inbox). The reason is required and logged in lead_events. Sequences for the lead then use
 * the neutral greeting.
 */
export function overrideDirectContact(db: Db, leadId: string, reason: string, now: () => Date = () => new Date()): DirectContactOverride {
  const why = reason.trim();
  if (why.length < MIN_OVERRIDE_REASON) throw new Error(`an override needs a reason of at least ${MIN_OVERRIDE_REASON} characters`);
  const lead = db.select({ id: leads.id, status: leads.status }).from(leads).where(eq(leads.id, leadId)).get();
  if (!lead) throw new Error(`lead ${leadId} not found`);
  const at = now().toISOString();
  db.update(leads)
    .set({
      directContactOverrideReason: why,
      directContactOverrideAt: at,
      ...(lead.status === "needs_direct_contact" ? { status: "extracted" as const } : {}),
      updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    })
    .where(eq(leads.id, leadId))
    .run();
  db.insert(leadEvents).values({ leadId, kind: "direct_contact_override", detail: why }).run();
  return { reason: why, at };
}
