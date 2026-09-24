import {
  containsPhrase,
  isFound,
  NOT_FOUND,
  type EvidenceConfig,
  type ExclusionSignal,
  type ExtractedFacts,
  type FirmType,
  type Gate,
  type Person,
  type ScoringConfig,
} from "@clearpath/shared";
import { keywordIn } from "../extract/verify";

type Fit = { value: boolean | null; reason: string; qualifying_type: FirmType | null };
type Keywords = EvidenceConfig["firm_type_keywords"];

/**
 * Decision maker = the named person whose title matches the earliest entry in the docs/06
 * preference list. People with other titles rank next, people with no title last; ties keep the
 * page order. role_confirmed is false unless the chosen person's title is on the list.
 */
export function chooseDecisionMaker(people: Person[], preferences: string[]) {
  if (people.length === 0) return NOT_FOUND;
  const rank = (p: Person) => {
    if (!p.title) return preferences.length + 1;
    const i = preferences.findIndex((pref) => containsPhrase(p.title!, pref));
    return i === -1 ? preferences.length : i;
  };
  const best = people.map((p, i) => ({ p, i, r: rank(p) })).sort((a, b) => a.r - b.r || a.i - b.i)[0]!.p;
  const role_confirmed = best.title !== null && preferences.some((pref) => containsPhrase(best.title!, pref));
  return { value: { name: best.name, title: best.title, role_confirmed }, evidence_url: best.evidence_url, evidence_quote: best.evidence_quote };
}

/** Text of the verified services list (each item was found on a fetched page), for keyword checks. */
function servicesText(services: ExtractedFacts["services"]): string {
  if (!isFound(services)) return "";
  return services.value.join(" \n ");
}

/** Types whose keywords appear in the verified services. */
export function typesShownInServices(services: ExtractedFacts["services"], keywords: Keywords): FirmType[] {
  const text = servicesText(services);
  if (!text) return [];
  return (Object.keys(keywords) as (keyof Keywords)[]).filter((t) => keywords[t].some((k) => keywordIn(text, k)));
}

/** Keeps only secondary types the verified services actually show; notes the rest. */
export function supportedSecondaryTypes(
  firmType: ExtractedFacts["firm_type"],
  services: ExtractedFacts["services"],
  keywords: Keywords,
): { firmType: ExtractedFacts["firm_type"]; notes: string[] } {
  if (!isFound(firmType)) return { firmType, notes: [] };
  const shown = new Set(typesShownInServices(services, keywords));
  const keep = firmType.value.secondary.filter((t) => t !== firmType.value.primary && shown.has(t));
  const notes = firmType.value.secondary
    .filter((t) => !keep.includes(t) && t !== firmType.value.primary)
    .map((t) => `firm_type: dropped secondary type ${t} (not shown in the verified services)`);
  return { firmType: { ...firmType, value: { ...firmType.value, secondary: keep } }, notes };
}

const US_NAMES = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);
const US_STATES = new Set(
  (
    "al,ak,az,ar,ca,co,ct,de,dc,fl,ga,hi,id,il,in,ia,ks,ky,la,me,md,ma,mi,mn,ms,mo,mt,ne,nv,nh,nj,nm,ny,nc,nd,oh,ok,or,pa,ri,sc,sd,tn,tx,ut,vt,va,wa,wv,wi,wy," +
    "alabama,alaska,arizona,arkansas,california,colorado,connecticut,delaware,district of columbia,florida,georgia,hawaii,idaho,illinois,indiana,iowa,kansas,kentucky,louisiana,maine,maryland,massachusetts,michigan,minnesota,mississippi,missouri,montana,nebraska,nevada,new hampshire,new jersey,new mexico,new york,north carolina,north dakota,ohio,oklahoma,oregon,pennsylvania,rhode island,south carolina,south dakota,tennessee,texas,utah,vermont,virginia,washington,west virginia,wisconsin,wyoming"
  ).split(","),
);

/** US location from the verified location (country, or a US state when the country is not stated). */
export function usLocation(location: ExtractedFacts["location"]): Fit {
  if (!isFound(location)) return { value: null, reason: "location is NOT_FOUND", qualifying_type: null };
  const country = location.value.country?.trim().toLowerCase() ?? null;
  const state = location.value.state?.trim().toLowerCase().replace(/\.$/, "") ?? null;
  if (country && US_NAMES.has(country)) return { value: true, reason: `country ${location.value.country}`, qualifying_type: null };
  if (country) return { value: false, reason: `country ${location.value.country} is not the US`, qualifying_type: null };
  if (state && US_STATES.has(state)) return { value: true, reason: `US state ${location.value.state}`, qualifying_type: null };
  return { value: null, reason: "location does not say which country", qualifying_type: null };
}

/**
 * Target industry fit, decided by code (never the model): the primary type is a target type, or a
 * supported secondary type is, or the verified services contain a target type's keywords.
 */
export function targetIndustryFit(
  firmType: ExtractedFacts["firm_type"],
  services: ExtractedFacts["services"],
  scoring: ScoringConfig,
  keywords: Keywords,
): Fit {
  const targets = new Set<FirmType>(scoring.target_firm_types);
  if (!isFound(firmType) && !isFound(services)) {
    return { value: null, reason: "firm type and services are NOT_FOUND", qualifying_type: null };
  }
  if (isFound(firmType)) {
    if (targets.has(firmType.value.primary)) {
      return { value: true, reason: `primary type ${firmType.value.primary} is a target type`, qualifying_type: firmType.value.primary };
    }
    const secondary = firmType.value.secondary.find((t) => targets.has(t));
    if (secondary) return { value: true, reason: `secondary type ${secondary} is shown in services`, qualifying_type: secondary };
  }
  const shown = typesShownInServices(services, keywords).find((t) => targets.has(t));
  if (shown) return { value: true, reason: `services show ${shown} keywords`, qualifying_type: shown };
  const primary = isFound(firmType) ? firmType.value.primary : "unknown";
  return { value: false, reason: `primary type ${primary} is not a target type and services show no target-industry keywords`, qualifying_type: null };
}

/**
 * Gates (docs/06). No sequence is written for a gated lead until the founder approves.
 *  - out_of_icp: staff above max_staff_for_sequence, or target industry fit is false.
 *  - needs_review: any exclusion signal.
 */
export function computeGate(input: {
  sizeSignal: ExtractedFacts["size_signal"];
  targetIndustryFit: Fit;
  exclusionSignals: ExclusionSignal[];
  scoring: ScoringConfig;
}): Gate {
  const out: string[] = [];
  const review: string[] = [];
  const staff = isFound(input.sizeSignal) ? input.sizeSignal.value.staff_count : null;
  if (staff !== null && staff > input.scoring.max_staff_for_sequence) {
    out.push(`staff count ${staff} is above max_staff_for_sequence ${input.scoring.max_staff_for_sequence}`);
  }
  if (input.targetIndustryFit.value === false) out.push(`target industry fit is false: ${input.targetIndustryFit.reason}`);
  for (const s of input.exclusionSignals) review.push(`exclusion signal ${s.signal}: "${s.evidence_quote}"`);
  const status = out.length > 0 ? "out_of_icp" : review.length > 0 ? "needs_review" : "qualified";
  return { status, reasons: [...out, ...review] };
}

/** One page's full cleaned text (the keyword fallback searches these, never the capped copy). */
interface SearchPage {
  url: string;
  text: string;
}

/**
 * The first span of at most 15 words, copied verbatim from a paragraph of the page, that contains
 * the keyword and no personal term. The evidence quote for a code-derived firm type.
 */
export function keywordQuote(pageText: string, keyword: string, personalTerms: string[]): string | null {
  for (const paragraph of pageText.split(/\n{2,}/)) {
    if (!keywordIn(paragraph, keyword)) continue;
    const words = paragraph.replace(/\s+/g, " ").trim().split(" ");
    for (let i = 0; i < words.length; i++) {
      const span = words.slice(i, i + 15).join(" ");
      if (!keywordIn(span, keyword)) {
        if (i + 15 >= words.length) break;
        continue;
      }
      if (personalTerms.some((t) => containsPhrase(span, t))) break;
      return span;
    }
  }
  return null;
}

/**
 * Deterministic firm type when the model's answer did not verify: count docs/06 firm_type_keywords
 * hits in the verified services (weight 2) and in the full text of the fetched pages (one per page
 * and keyword). The type with the most hits wins; ties go to the docs/06 order. When the model named
 * a type whose own quote failed, that type is tried first: it is kept only if the code finds its own
 * verbatim keyword quote for it. The evidence quote is always a verbatim span of a fetched page that
 * contains a docs/06 keyword. Secondary types are the other types the verified services show.
 * source is "code".
 */
export function firmTypeFromKeywords(
  pages: SearchPage[],
  services: ExtractedFacts["services"],
  evidence: EvidenceConfig,
  proposed: FirmType | null = null,
): ExtractedFacts["firm_type"] {
  const keywords = evidence.firm_type_keywords;
  const types = Object.keys(keywords) as (keyof Keywords)[];
  const serviceItems = isFound(services) ? services.value : [];
  const score = (t: keyof Keywords) =>
    serviceItems.filter((s) => keywords[t].some((k) => keywordIn(s, k))).length * 2 +
    pages.reduce((n, p) => n + keywords[t].filter((k) => keywordIn(p.text, k)).length, 0);
  const ranked = types.map((t, i) => ({ t, i, s: score(t) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
  const order = proposed && proposed !== "other" ? [{ t: proposed as keyof Keywords }, ...ranked.filter((x) => x.t !== proposed)] : ranked;
  for (const { t } of order) {
    for (const page of pages) {
      for (const k of keywords[t]) {
        const quote = keywordIn(page.text, k) ? keywordQuote(page.text, k, evidence.personal_terms) : null;
        if (!quote) continue;
        const secondary = typesShownInServices(services, keywords).filter((x) => x !== t).slice(0, 3);
        return { value: { primary: t, secondary, source: "code" }, evidence_url: page.url, evidence_quote: quote };
      }
    }
  }
  return NOT_FOUND;
}
