import {
  isFound,
  type Dossier,
  type ScoringConfig,
  type ScoringKey,
  type Tier,
} from "@clearpath/shared";

export interface CriterionResult {
  key: ScoringKey;
  group: "fit" | "signals" | "reachability";
  label: string;
  max: number;
  points: number;
  /** Why it scored or did not, in plain words. */
  reason: string;
  /** Dossier fields the decision used (for evidence links in the UI). */
  fields: string[];
}

export interface ScoreResult {
  total: number;
  tier: Tier;
  fitPoints: number;
  /** True when the tier was capped at C because fit points are below fit_threshold. */
  tierCapped: boolean;
  gate: Dossier["gate"];
  breakdown: CriterionResult[];
}

interface Verdict {
  met: boolean;
  reason: string;
  fields: string[];
}

const NOT_FOUND_REASON = (field: string) => `${field} is NOT_FOUND (scores 0; never a negative finding)`;

function emailDomain(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * A partial date as the last moment it could refer to: "2025-09" -> end of Sept 2025 (benefit of
 * the doubt within the precision the site gave), "2025-09-14" -> end of that day. UTC.
 */
export function partialDateEnd(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number | undefined];
  return d === undefined ? new Date(Date.UTC(y, m, 1) - 1) : new Date(Date.UTC(y, m - 1, d + 1) - 1);
}

function monthsBefore(asOf: Date, months: number): Date {
  const d = new Date(asOf.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

function keywordRegex(keyword: string): RegExp {
  return new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
}

type Rule = (d: Dossier, c: ScoringConfig, asOf: Date) => Verdict;

const RULES: Record<ScoringKey, Rule> = {
  firm_type_in_target: (d, c) => {
    if (!isFound(d.firm_type)) return { met: false, reason: NOT_FOUND_REASON("firm_type"), fields: [] };
    const { primary, secondary } = d.firm_type.value;
    if (c.target_firm_types.includes(primary)) return { met: true, reason: `primary type ${primary} is a target`, fields: ["firm_type"] };
    const viaSecondary = secondary.find((t) => c.target_firm_types.includes(t));
    if (viaSecondary) return { met: true, reason: `secondary type ${viaSecondary} (shown in services) is a target`, fields: ["firm_type", "services"] };
    return { met: false, reason: `firm type ${primary} is not a target`, fields: ["firm_type"] };
  },

  target_industry_fit: (d) => ({
    met: d.target_industry_fit.value === true,
    reason: d.target_industry_fit.reason,
    fields: ["target_industry_fit"],
  }),

  us_location: (d) => ({ met: d.us_location.value === true, reason: d.us_location.reason, fields: ["location"] }),

  size_in_range: (d, c) => {
    if (!isFound(d.size_signal)) return { met: false, reason: NOT_FOUND_REASON("size_signal"), fields: [] };
    const n = d.size_signal.value.staff_count;
    const { min, max } = c.staff_range;
    if (n === null) return { met: false, reason: "size signal has no staff count", fields: ["size_signal"] };
    const met = n >= min && n <= max;
    return { met, reason: `${n} staff (${met ? "within" : "outside"} ${min}-${max})`, fields: ["size_signal"] };
  },

  decision_maker_named: (d) =>
    isFound(d.decision_maker)
      ? { met: true, reason: `decision maker: ${d.decision_maker.value.name}${d.decision_maker.value.title ? `, ${d.decision_maker.value.title}` : ""}`, fields: ["decision_maker"] }
      : { met: false, reason: NOT_FOUND_REASON("decision_maker"), fields: [] },

  // Evidenced by the code's recorded keyword search of the full page text (docs/06), never by NOT_FOUND.
  no_wisp_mention: (d, c) => {
    if (isFound(d.security_or_wisp_mention)) {
      return { met: false, reason: "site mentions security or a WISP", fields: ["security_or_wisp_mention"] };
    }
    const search = d.security_mention_search;
    if (search === "NOT_CHECKED") return { met: false, reason: "no keyword search was recorded (scores 0)", fields: [] };
    const searched = new Set(search.keywords.map((k) => k.toLowerCase()));
    const missing = c.wisp_keywords.filter((k) => !searched.has(k.toLowerCase()));
    if (missing.length > 0) {
      return { met: false, reason: `keyword list changed since the search (missing: ${missing.join(", ")}); re-run`, fields: [] };
    }
    const opened = new Set(d.pages_opened);
    const complete = search.pages.filter(
      (p) =>
        opened.has(p.url) &&
        p.http_status === 200 &&
        /^text\/html\b/i.test(p.content_type) &&
        !p.truncated &&
        p.text_chars >= c.wisp_search_min_text_chars,
    );
    const hasHome = complete.some((p) => p.kind === "home");
    const hasPolicyPage = complete.some((p) => p.kind === "privacy" || p.kind === "security");
    if (!hasHome || (!hasPolicyPage && complete.length < c.wisp_min_pages)) {
      return {
        met: false,
        reason: `search needs the homepage plus a privacy or security page, or at least ${c.wisp_min_pages} complete pages (had ${complete.length})`,
        fields: [],
      };
    }
    if (search.matches.length > 0) {
      const found = [...new Set(search.matches.map((m) => m.keyword))];
      return { met: false, reason: `keyword search found: ${found.join(", ")}`, fields: ["security_mention_search"] };
    }
    return {
      met: true,
      reason: `searched ${complete.length} complete pages for ${search.keywords.length} keywords: none found`,
      fields: ["security_mention_search"],
    };
  },

  dmarc_missing_or_none: (d) => {
    const noEmail = d.dns.no_domain_email;
    if (!isFound(noEmail)) return { met: false, reason: "MX lookup failed or not run; DMARC not scored", fields: [] };
    if (noEmail.value) return { met: false, reason: "domain has no MX records (no_domain_email); DMARC not scored", fields: ["dns.no_domain_email"] };
    const present = d.dns.dmarc_present;
    const policy = d.dns.dmarc_policy;
    if (isFound(present) && present.value === false) {
      return { met: true, reason: "no DMARC record (DNS lookup)", fields: ["dns.dmarc_present"] };
    }
    if (isFound(policy) && policy.value === "none") {
      return { met: true, reason: "DMARC policy is none (DNS lookup)", fields: ["dns.dmarc_policy"] };
    }
    if (!isFound(present)) return { met: false, reason: "DMARC lookup failed; not scored", fields: [] };
    return { met: false, reason: "DMARC record present with an enforcing (or unreadable) policy", fields: ["dns.dmarc_policy"] };
  },

  personal_email_domain: (d, c) => {
    if (!isFound(d.personal_email_domain_on_site)) {
      return { met: false, reason: NOT_FOUND_REASON("personal_email_domain_on_site"), fields: [] };
    }
    const domain = emailDomain(d.personal_email_domain_on_site.value);
    const met = c.personal_email_domains.some((p) => domain === p || domain.endsWith(`.${p}`));
    return {
      met,
      reason: met ? `firm uses a ${domain} address` : `${domain} is not a personal email provider`,
      fields: ["personal_email_domain_on_site"],
    };
  },

  sensitive_data_services: (d, c) => {
    if (!isFound(d.services)) return { met: false, reason: NOT_FOUND_REASON("services"), fields: [] };
    const services = d.services.value;
    const hits = c.sensitive_data_keywords.filter((k) => services.some((s) => keywordRegex(k).test(s)));
    return {
      met: hits.length > 0,
      reason: hits.length > 0 ? `services involve ${hits.join(", ")} data` : "no tax, payroll, or credit services listed",
      fields: ["services"],
    };
  },

  doc_exchange_without_portal: (d) => {
    const f = d.client_portal_or_doc_exchange;
    if (!isFound(f)) return { met: false, reason: NOT_FOUND_REASON("client_portal_or_doc_exchange"), fields: [] };
    const met = f.value.doc_exchange && !f.value.secure_portal;
    return {
      met,
      reason: met
        ? "mentions document exchange without a secure portal"
        : f.value.secure_portal
          ? "mentions a secure portal"
          : "no document exchange language",
      fields: ["client_portal_or_doc_exchange"],
    };
  },

  public_business_email: (d) =>
    isFound(d.public_contact_email)
      ? { met: true, reason: `public contact email ${d.public_contact_email.value.address}`, fields: ["public_contact_email"] }
      : { met: false, reason: NOT_FOUND_REASON("public_contact_email"), fields: [] },

  // Deterministic: machine-readable dates only (latest_dated_content is filled by code).
  site_maintained: (d, c, asOf) => {
    const f = d.latest_dated_content;
    if (!isFound(f)) return { met: false, reason: "no machine-readable date found (scores 0)", fields: [] };
    const cutoff = monthsBefore(asOf, c.site_maintained_months);
    const met = partialDateEnd(f.value.date) >= cutoff;
    return {
      met,
      reason: `newest date ${f.value.date} from ${f.value.source} (${met ? "within" : "older than"} ${c.site_maintained_months} months)`,
      fields: ["latest_dated_content"],
    };
  },

  phone_or_contact_form: (d) => {
    const f = d.phone_or_contact_form;
    if (!isFound(f)) return { met: false, reason: NOT_FOUND_REASON("phone_or_contact_form"), fields: [] };
    const met = f.value.phone !== null || f.value.contact_form;
    return { met, reason: met ? "phone or contact form present" : "neither phone nor contact form", fields: ["phone_or_contact_form"] };
  },
};

export function tierFor(total: number, config: ScoringConfig): Tier {
  if (total >= config.tiers.A) return "A";
  if (total >= config.tiers.B) return "B";
  return "C";
}

/**
 * Deterministic lead score per docs/06. Pure: same dossier, config, and date always give the same
 * result. Fit is scored first; signal points count only when the fit gates pass (the lead is not
 * out_of_icp); a fit score below fit_threshold caps the tier at C.
 */
export function scoreDossier(dossier: Dossier, config: ScoringConfig, asOf: Date): ScoreResult {
  const gatesPass = dossier.gate.status !== "out_of_icp";
  const breakdown = config.criteria.map((criterion): CriterionResult => {
    const v = RULES[criterion.key](dossier, config, asOf);
    const blocked = criterion.group === "signals" && !gatesPass;
    return {
      key: criterion.key,
      group: criterion.group,
      label: criterion.label,
      max: criterion.points,
      points: v.met && !blocked ? criterion.points : 0,
      reason: blocked && v.met ? `${v.reason} (not counted: lead is out_of_icp)` : v.reason,
      fields: v.fields,
    };
  });
  const total = breakdown.reduce((s, c) => s + c.points, 0);
  const fitPoints = breakdown.filter((b) => b.group === "fit").reduce((s, b) => s + b.points, 0);
  const tierCapped = fitPoints < config.fit_threshold && tierFor(total, config) !== "C";
  return { total, tier: tierCapped ? "C" : tierFor(total, config), fitPoints, tierCapped, gate: dossier.gate, breakdown };
}
