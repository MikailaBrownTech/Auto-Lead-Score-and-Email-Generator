import type { SupabaseClient } from "@supabase/supabase-js";
import { OfferConfigSchema, type OfferConfig } from "@clearpath/shared";
import { normalizeOffer } from "../docs/loader";

/** The columns matching OfferConfig's own fields (not id, not monthly_spend_cap_usd -- the spend cap
 * stays env-var-controlled, MONTHLY_SPEND_CAP_USD; this table's column for it exists for the
 * migration's fidelity but isn't read by the live app yet). */
const OFFER_COLUMNS = "sender_name,sender_title,company_name,company_website,opt_out_line,physical_address,approved_proof,founding_client_offer,booking_link,region,company_one_liner,include_dns_observation,checklist_ready";

export interface SettingsDb {
  getOffer(): Promise<OfferConfig>;
}

export function realSettingsDb(supa: SupabaseClient): SettingsDb {
  return {
    async getOffer() {
      const { data, error } = await supa.from("settings").select(OFFER_COLUMNS).eq("id", true).maybeSingle();
      if (error) throw new Error(`Could not read settings: ${error.message}`);
      if (!data) throw new Error("No settings row found. The migration should have created one (supabase/migrations/..._settings.sql).");
      return normalizeOffer(OfferConfigSchema.parse(data));
    },
  };
}

/**
 * Settings writes are owner-only (RLS: settings_update_owner). `supa` here must be a request-scoped
 * client built from the calling user's own access token (createRequestClient), not the service role
 * client, so Postgres's own is_owner() check actually applies -- a staff account's update is silently
 * filtered to 0 rows by RLS rather than erroring, which this reports as a plain permission message.
 */
export async function updateOfferSettings(supa: SupabaseClient, patch: Partial<OfferConfig>): Promise<OfferConfig> {
  const row: Record<string, unknown> = { ...patch };
  if (typeof row.founding_client_offer === "string" && row.founding_client_offer.trim() === "") row.founding_client_offer = null;
  const { data, error } = await supa.from("settings").update(row).eq("id", true).select(OFFER_COLUMNS).maybeSingle();
  if (error) throw new Error(`Settings were not saved: ${error.message}`);
  if (!data) throw new Error("Settings were not saved: only an owner can change settings.");
  return normalizeOffer(OfferConfigSchema.parse(data));
}
