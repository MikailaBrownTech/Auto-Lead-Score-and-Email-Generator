import { isFound, type Dossier } from "@clearpath/shared";
import type { EventsDb } from "../db/supa-sequences";
import type { LeadsDb } from "../db/supa-leads";

/**
 * A lead without a named contact is a warning, never a block: drafting, approval, and export all
 * proceed with the neutral greeting. The status no_named_contact and the badges only say that reply
 * odds are lower (or, with no address at all, that one must be added before sending).
 */

/** A per-lead contact override, with the reason the founder gave. Optional; it only clears the label. */
export interface DirectContactOverride {
  reason: string;
  at: string;
}

/** A lead without a person-tied public address: a generic inbox, an unattributed address, or none. */
export function lacksNamedContact(d: Dossier): boolean {
  return d.public_email_kind !== "named_person";
}

/** The public address, or null when none was found. */
export function publicAddress(d: Dossier): string | null {
  return isFound(d.public_contact_email) ? d.public_contact_email.value.address : null;
}

/**
 * The contact warning in plain words (badge, lead page, CSV contact_note); null for a named contact.
 * Never a guessed or constructed address or name.
 */
export function contactWarning(d: Dossier): string | null {
  if (!lacksNamedContact(d)) return null;
  if (!publicAddress(d)) return "no public email; add before sending";
  if (d.public_email_kind === "generic_inbox") return "generic inbox: lower reply odds";
  return "address not tied to a named person: lower reply odds";
}

/** Optional public sources for an owner name or email (shown on the lead page and in reports). */
export function namedContactChecklist(d: Dossier): string[] {
  const state = isFound(d.location) ? d.location.value.state : null;
  const firm = isFound(d.firm_name) ? d.firm_name.value : "the firm";
  return [
    "[ ] Paste the owner's name and email via paste mode, if you find them.",
    `[ ] State accountancy board license lookup${state ? ` (${state})` : ""}: search ${firm} or its owner for the licensee name.`,
    `[ ] Secretary of State business search${state ? ` (${state})` : ""}: registered agent and officers for ${firm}.`,
    `[ ] Google Business Profile for ${firm}: owner name, and whether a direct email is listed.`,
  ];
}

export async function leadOverride(leadsDb: LeadsDb, leadId: string): Promise<DirectContactOverride | null> {
  const row = await leadsDb.get(leadId);
  return row?.directContactOverrideReason && row.directContactOverrideAt ? { reason: row.directContactOverrideReason, at: row.directContactOverrideAt } : null;
}

/** Minimum length of an override reason, so the log says something useful. */
export const MIN_OVERRIDE_REASON = 10;

/**
 * Marks one lead's contact as accepted (e.g. a solo practice whose only address is the owner's
 * inbox): clears the no_named_contact label. Not required to proceed. The reason is required and
 * logged in lead_events. Sequences for the lead keep the neutral greeting.
 */
export async function overrideDirectContact(leadsDb: LeadsDb, eventsDb: EventsDb, leadId: string, reason: string, now: () => Date = () => new Date()): Promise<DirectContactOverride> {
  const why = reason.trim();
  if (why.length < MIN_OVERRIDE_REASON) throw new Error(`an override needs a reason of at least ${MIN_OVERRIDE_REASON} characters`);
  const lead = await leadsDb.get(leadId);
  if (!lead) throw new Error(`lead ${leadId} not found`);
  const at = now().toISOString();
  await leadsDb.update(leadId, {
    directContactOverrideReason: why,
    directContactOverrideAt: at,
    ...(lead.status === "no_named_contact" ? { status: "extracted" as const } : {}),
  });
  await eventsDb.insert({ leadId, kind: "direct_contact_override", detail: why });
  return { reason: why, at };
}
