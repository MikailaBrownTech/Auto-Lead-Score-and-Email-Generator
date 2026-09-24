import { isFound, type Dossier, type OfferConfig } from "@clearpath/shared";
import { SETTINGS_FIELDS, type SettingsField, type TemplateSet } from "../docs/templates";

/** Legal suffixes stripped for {{firm_short}}: "Smith & Jones, LLC" -> "Smith & Jones". */
const LEGAL_SUFFIX = /[\s,]+(?:L\.?L\.?C\.?|L\.?L\.?P\.?|P\.?L\.?L\.?C\.?|P\.?L\.?L\.?P\.?|Inc\.?|Incorporated|P\.?C\.?|P\.?A\.?|Ltd\.?|Limited|Corp\.?|Corporation|Co\.)$/i;

export function firmShort(firm: string): string {
  let s = firm.trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(LEGAL_SUFFIX, "").replace(/[\s,]+$/, "");
    if (next === s || next === "") break;
    s = next;
  }
  return s || firm.trim();
}

/** Lead merge values (verified facts only); null when the fact is NOT_FOUND. */
export function leadFields(d: Dossier): { firm: string | null; firm_short: string | null; city: string | null } {
  const firm = isFound(d.firm_name) ? d.firm_name.value.trim() : null;
  const city = isFound(d.location) ? d.location.value.city?.trim() || null : null;
  return { firm, firm_short: firm ? firmShort(firm) : null, city };
}

/** The docs/01 value behind each settings merge field ("" when empty). */
export function settingsValue(field: SettingsField, offer: OfferConfig): string {
  switch (field) {
    case "company":
      return offer.company_name.trim();
    case "offer":
      return (offer.founding_client_offer ?? "").trim();
    case "booking_link":
      return offer.booking_link.trim();
    case "region":
      return offer.region.trim();
    case "company_one_liner":
      return offer.company_one_liner.trim();
  }
}

/** Settings merge fields a text uses whose docs/01 value is empty (export is blocked while any is). */
export function emptySettingsUsed(text: string, offer: OfferConfig): SettingsField[] {
  return SETTINGS_FIELDS.filter((f) => text.includes(`{{${f}}}`) && settingsValue(f, offer) === "");
}

/**
 * Fills the settings merge fields from docs/01. An empty setting stays as its {{placeholder}} (so the
 * preview shows what is missing and export stays blocked); nothing is ever invented for it.
 */
export function renderSettings(text: string, offer: OfferConfig): string {
  let out = text;
  for (const f of SETTINGS_FIELDS) {
    const v = settingsValue(f, offer);
    if (v) out = out.split(`{{${f}}}`).join(v);
  }
  return out;
}

/** The docs/09 signature block with docs/01 values; a line whose fields are all empty is left out. */
export function renderSignature(template: TemplateSet["signature"], offer: OfferConfig): string[] {
  const values: Record<string, string> = {
    sender_name: offer.sender_name.trim(),
    sender_title: offer.sender_title.trim(),
    company: offer.company_name.trim(),
    website: offer.company_website.trim(),
    opt_out_line: offer.opt_out_line.trim(),
    physical_address: offer.physical_address.trim(),
  };
  const out: string[] = [];
  for (const line of template) {
    if (line === "") {
      if (out.length && out.at(-1) !== "") out.push("");
      continue;
    }
    const fields = [...line.matchAll(/\{\{([a-z_]+)\}\}/g)].map((m) => m[1]!);
    if (fields.length > 0 && fields.every((f) => !values[f])) continue;
    const filled = line
      .replace(/\{\{([a-z_]+)\}\}/g, (_, f: string) => values[f] ?? "")
      .replace(/^[\s,]+|[\s,]+$/g, "")
      .replace(/,\s*,/g, ",");
    if (filled) out.push(filled);
  }
  while (out.at(-1) === "") out.pop();
  return out;
}
