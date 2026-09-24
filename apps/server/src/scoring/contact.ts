import { isFound, NOT_FOUND, type Dossier, type ExtractedFacts, type PublicEmailKind } from "@clearpath/shared";
import { wordsOf } from "../extract/verify";

export interface ContactPlan {
  /** "Hi Jane," when the public address belongs to the decision maker; null = email 1 opens with the docs/09 role-based line. */
  greeting: string | null;
  greetFirstName: string | null;
  /** True when a decision maker is known but the public address is not tied to them (export flag). */
  contactMismatch: boolean;
  /** True when the public address is a shared role inbox (info@, office@ ...). Never greeted by name. */
  genericInbox: boolean;
  reason: string;
}

function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
}

function nameParts(name: string): { first: string; last: string } {
  const parts = wordsOf(name).split(" ").filter(Boolean);
  return { first: letters(parts[0] ?? ""), last: letters(parts[parts.length - 1] ?? "") };
}

/** True when the address's local part is a shared role inbox from the docs/06 generic_inbox_prefixes list. */
export function isGenericInbox(address: string, prefixes: string[]): boolean {
  const local = address.slice(0, address.indexOf("@")).toLowerCase();
  // "info", "info2", "info.columbus", "office-oh" all count; "information@" does not.
  return prefixes.some((p) => local === p || (local.startsWith(p) && /^[._-]|^\d+$/.test(local.slice(p.length))));
}

/**
 * How the public address relates to the people named on the site (code, from verified facts):
 * generic_inbox for a role inbox (always wins), named_person when the same quote names its owner or
 * the address is built from a named person's name, otherwise unattributed.
 */
export function classifyPublicEmail(
  email: ExtractedFacts["public_contact_email"],
  people: ExtractedFacts["people"],
  genericPrefixes: string[],
): PublicEmailKind | typeof NOT_FOUND {
  if (!isFound(email)) return NOT_FOUND;
  const { address, owner_name } = email.value;
  if (isGenericInbox(address, genericPrefixes)) return "generic_inbox";
  if (owner_name && wordsOf(owner_name) !== "") return "named_person";
  return people.some((p) => {
    const { first, last } = nameParts(p.name);
    return localPartMatches(address, first, last);
  })
    ? "named_person"
    : "unattributed";
}

/** The address is the person's when its local part is built from their name (jane@, jsmith@, jane.smith@). */
function localPartMatches(address: string, first: string, last: string): boolean {
  const local = letters(address.slice(0, address.indexOf("@")));
  if (!local || !first) return false;
  const options = [first, first + last, last + first, first[0] + last, first + (last[0] ?? "")];
  if (last) options.push(last);
  return options.filter((o) => o.length >= 3).includes(local);
}

/**
 * Greeting rule for the writer: greet the decision maker by first name only when the public
 * contact address is tied to that person, either by the owner_name in the same quote or by an
 * address built from their name, and is not a generic inbox. Otherwise no name (email 1 opens with
 * the docs/09 role-based line) and flag contact_mismatch (or generic_inbox).
 */
export function contactPlan(d: Dossier): ContactPlan {
  const genericInbox = d.public_email_kind === "generic_inbox";
  const neutral = (contactMismatch: boolean, reason: string): ContactPlan => ({ greeting: null, greetFirstName: null, contactMismatch, genericInbox, reason });
  if (genericInbox && isFound(d.public_contact_email)) {
    return neutral(isFound(d.decision_maker), `${d.public_contact_email.value.address} is a generic inbox`);
  }
  if (!isFound(d.decision_maker)) return neutral(false, "no decision maker named");
  const name = d.decision_maker.value.name;
  const { first, last } = nameParts(name);
  const firstDisplay = name.trim().split(/\s+/)[0]!;
  if (!isFound(d.public_contact_email)) return neutral(true, `no public address for ${name}`);

  const { address, owner_name } = d.public_contact_email.value;
  const ownerMatches = owner_name !== null && wordsOf(owner_name) !== "" && (wordsOf(owner_name) === wordsOf(name) || (wordsOf(owner_name).includes(first) && wordsOf(owner_name).includes(last)));
  if (ownerMatches || localPartMatches(address, first, last)) {
    return { greeting: `Hi ${firstDisplay},`, greetFirstName: firstDisplay, contactMismatch: false, genericInbox: false, reason: `${address} belongs to ${name}` };
  }
  return neutral(true, `${address} is not tied to ${name}${owner_name ? ` (the page ties it to ${owner_name})` : ""}`);
}

