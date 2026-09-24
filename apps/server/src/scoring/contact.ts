import { isFound, type Dossier } from "@clearpath/shared";
import { wordsOf } from "../extract/verify";

export interface ContactPlan {
  /** "Hi Jane," when the public address belongs to the decision maker, otherwise "Hi,". */
  greeting: string;
  greetFirstName: string | null;
  /** True when a decision maker is known but the public address is not tied to them (export flag). */
  contactMismatch: boolean;
  reason: string;
}

function letters(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, "");
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
 * address built from their name. Otherwise use a neutral greeting and flag contact_mismatch.
 */
export function contactPlan(d: Dossier): ContactPlan {
  const neutral = (contactMismatch: boolean, reason: string): ContactPlan => ({ greeting: "Hi,", greetFirstName: null, contactMismatch, reason });
  if (!isFound(d.decision_maker)) return neutral(false, "no decision maker named");
  const name = d.decision_maker.value.name;
  const parts = wordsOf(name).split(" ").filter(Boolean);
  const first = letters(parts[0] ?? "");
  const last = letters(parts[parts.length - 1] ?? "");
  const firstDisplay = name.trim().split(/\s+/)[0]!;
  if (!isFound(d.public_contact_email)) return neutral(true, `no public address for ${name}`);

  const { address, owner_name } = d.public_contact_email.value;
  const ownerMatches = owner_name !== null && wordsOf(owner_name) !== "" && (wordsOf(owner_name) === wordsOf(name) || (wordsOf(owner_name).includes(first) && wordsOf(owner_name).includes(last)));
  if (ownerMatches || localPartMatches(address, first, last)) {
    return { greeting: `Hi ${firstDisplay},`, greetFirstName: firstDisplay, contactMismatch: false, reason: `${address} belongs to ${name}` };
  }
  return neutral(true, `${address} is not tied to ${name}${owner_name ? ` (the page ties it to ${owner_name})` : ""}`);
}
