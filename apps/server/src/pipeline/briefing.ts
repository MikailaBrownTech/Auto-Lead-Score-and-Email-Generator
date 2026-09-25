import fs from "node:fs";
import { FIRM_TYPES, isFound, type Dossier } from "@clearpath/shared";
import { z } from "zod";
import { fromRoot } from "../config/paths";
import type { CriterionResult, ScoreResult } from "../scoring/score";
import { lacksNamedContact, publicAddress } from "../scoring/direct-contact";

/**
 * Wording for the plain-language Briefing on the lead detail page (code-composed, no model call).
 * Every sentence lives here, not in code, so the phrasing can be tuned without a code change.
 */
const BriefingConfigSchema = z
  .object({
    footer_note: z.string().trim().min(1),
    firm_type_labels: z.record(z.string(), z.string().trim().min(1)),
    fit_in_range: z.string().trim().min(1),
    fit_out_of_range: z.string().trim().min(1),
    contact_no_email: z.string().trim().min(1),
    contact_generic_inbox: z.string().trim().min(1),
    contact_named_with_title: z.string().trim().min(1),
    contact_named_no_title: z.string().trim().min(1),
    role_status_confirmed: z.string().trim().min(1),
    role_status_unconfirmed: z.string().trim().min(1),
    services_summary: z.string().trim().min(1),
    security_no_mail: z.string().trim().min(1),
    security_no_dmarc: z.string().trim().min(1),
    security_dmarc_monitoring: z.string().trim().min(1),
    security_dmarc_enforced: z.string().trim().min(1),
    wisp_none_found: z.string().trim().min(1),
    freshness_known: z.string().trim().min(1),
    freshness_unknown: z.string().trim().min(1),
    access_declined: z.string().trim().min(1),
    access_incomplete: z.string().trim().min(1),
  })
  .strict();
export type BriefingConfig = z.infer<typeof BriefingConfigSchema>;

/** config/briefing.json, validated. Fails fast with a clear message if a template or a firm type label is missing. */
export function loadBriefingConfig(file = fromRoot("config/briefing.json")): BriefingConfig {
  const cfg = BriefingConfigSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  const missing = FIRM_TYPES.filter((t) => !(t in cfg.firm_type_labels));
  if (missing.length > 0) throw new Error(`config/briefing.json is missing firm_type_labels for: ${missing.join(", ")}`);
  return cfg;
}

/** Fills {{placeholders}} in a template. Throws if one is left unfilled (a config or code mistake). */
function render(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.split(`{{${k}}}`).join(v);
  const left = /\{\{[a-z_]+\}\}/.exec(out);
  if (left) throw new Error(`config/briefing.json template "${template}" has an unfilled placeholder ${left[0]}`);
  return out;
}

export const BRIEFING_TOPICS = ["fit", "contact", "services", "security", "wisp", "freshness", "access"] as const;
export type BriefingTopic = (typeof BRIEFING_TOPICS)[number];

export interface BriefingLine {
  topic: BriefingTopic;
  text: string;
}

export interface Briefing {
  lines: BriefingLine[];
  note: string;
}

const SIZE_GATE_RE = /^staff count \d+ is above max_staff_for_sequence \d+$/;

function criterion(score: ScoreResult, key: string): CriterionResult | undefined {
  return score.breakdown.find((b) => b.key === key);
}

/** "This firm is larger than your target range" when the gate itself says so; otherwise the normal fit line, only when size_in_range actually scored (never asserted as a guess). */
function fitLine(d: Dossier, score: ScoreResult, cfg: BriefingConfig): string | null {
  const sizeGated = d.gate.status === "out_of_icp" && d.gate.reasons.some((r) => SIZE_GATE_RE.test(r));
  if (sizeGated) {
    const staff = isFound(d.size_signal) ? d.size_signal.value.staff_count : null;
    return staff === null ? null : render(cfg.fit_out_of_range, { staff_count: String(staff) });
  }
  const c = criterion(score, "size_in_range");
  if (!c || c.points <= 0) return null;
  if (!isFound(d.firm_name) || !isFound(d.firm_type) || !isFound(d.location) || !isFound(d.size_signal)) return null;
  const { city } = d.location.value;
  const staff = d.size_signal.value.staff_count;
  if (!city || staff === null) return null;
  const label = cfg.firm_type_labels[d.firm_type.value.primary] ?? d.firm_type.value.primary.replace(/_/g, " ");
  return render(cfg.fit_in_range, { firm: d.firm_name.value, staff_count: String(staff), firm_type: label, city });
}

/** No email at all / a generic inbox only / a named, reachable contact — in that order, never a guess. */
function contactLine(d: Dossier, cfg: BriefingConfig): string | null {
  const email = publicAddress(d);
  if (!email) return cfg.contact_no_email;
  if (lacksNamedContact(d)) return render(cfg.contact_generic_inbox, { email });
  if (!isFound(d.decision_maker)) return null; // named per public_email_kind, but no decision maker on record: say nothing rather than guess
  const { name, title, role_confirmed } = d.decision_maker.value;
  const role_status = role_confirmed ? cfg.role_status_confirmed : cfg.role_status_unconfirmed;
  return title ? render(cfg.contact_named_with_title, { name, title, role_status, email }) : render(cfg.contact_named_no_title, { name, role_status, email });
}

/** Only when sensitive_data_services actually scored (docs/06); the service list itself is verified page text, never a guess. */
function servicesLine(d: Dossier, score: ScoreResult, cfg: BriefingConfig): string | null {
  const c = criterion(score, "sensitive_data_services");
  if (!c || c.points <= 0) return null;
  if (!isFound(d.services)) return null;
  const list = d.services.value;
  return render(cfg.services_summary, { count: String(list.length), examples: list.slice(0, 3).join(", ") });
}

/** The same 4 cases the docs/06 dmarc_missing_or_none rule checks: no mail at all, no DMARC, monitoring only, or enforced. Pure DNS lookups; never AI. */
function securityLine(d: Dossier, cfg: BriefingConfig): string | null {
  const noEmail = d.dns.no_domain_email;
  if (!isFound(noEmail)) return null;
  if (noEmail.value) return cfg.security_no_mail;
  const present = d.dns.dmarc_present;
  if (!isFound(present)) return null;
  if (!present.value) return cfg.security_no_dmarc;
  const policy = d.dns.dmarc_policy;
  if (!isFound(policy)) return null;
  return policy.value === "none" ? cfg.security_dmarc_monitoring : cfg.security_dmarc_enforced;
}

/** Only when no_wisp_mention actually scored (a complete keyword search that found nothing). */
function wispLine(d: Dossier, score: ScoreResult, cfg: BriefingConfig): string | null {
  const c = criterion(score, "no_wisp_mention");
  if (!c || c.points <= 0) return null;
  const search = d.security_mention_search;
  if (search === "NOT_CHECKED") return null;
  return render(cfg.wisp_none_found, { pages: String(search.pages.length) });
}

/** Only when site_maintained is part of this dossier's scoring; the date itself may still be unknown. */
function freshnessLine(d: Dossier, score: ScoreResult, cfg: BriefingConfig): string | null {
  if (!criterion(score, "site_maintained")) return null;
  return isFound(d.latest_dated_content) ? render(cfg.freshness_known, { date: d.latest_dated_content.value.date }) : cfg.freshness_unknown;
}

function accessLines(d: Dossier, score: ScoreResult, cfg: BriefingConfig): string[] {
  const out: string[] = [];
  if (d.declined_automated_access) out.push(cfg.access_declined);
  if (score.incompleteData.flag) out.push(cfg.access_incomplete);
  return out;
}

/**
 * Plain-language "Briefing" for the lead detail page: one short line per topic, code-composed from
 * fields already computed (no model call, no new data). A topic's line is left out entirely when its
 * underlying field is NOT_FOUND, unscored, or not applicable, rather than showing a filler sentence.
 */
export function buildBriefing(d: Dossier, score: ScoreResult, cfg: BriefingConfig): Briefing {
  const lines: BriefingLine[] = [];
  const push = (topic: BriefingTopic, text: string | null) => {
    if (text) lines.push({ topic, text });
  };
  push("fit", fitLine(d, score, cfg));
  push("contact", contactLine(d, cfg));
  push("services", servicesLine(d, score, cfg));
  push("security", securityLine(d, cfg));
  push("wisp", wispLine(d, score, cfg));
  push("freshness", freshnessLine(d, score, cfg));
  for (const text of accessLines(d, score, cfg)) push("access", text);
  return { lines, note: cfg.footer_note };
}
