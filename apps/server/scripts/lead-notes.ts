/**
 * Report lines shared by the live scripts: direct-contact status and checklist, incomplete data,
 * firm_type source, client count, and the internal email-security hint.
 */
import { isFound, type Dossier, type OfferConfig } from "@clearpath/shared";
import { directContactChecklist, directContactReason, lacksDirectContact, type DirectContactOverride } from "../src/scoring/direct-contact";
import type { ScoreResult } from "../src/scoring/score";

export function leadNotes(d: Dossier, score: ScoreResult, offer: OfferConfig, override: DirectContactOverride | null): string[] {
  const out: string[] = [];
  if (lacksDirectContact(d)) {
    if (override) out.push(`DIRECT CONTACT: overridden for this lead (${override.at}): "${override.reason}". Emails use the neutral greeting.`);
    else if (offer.allow_without_direct_contact) out.push(`DIRECT CONTACT: ${directContactReason(d)}; allowed by allow_without_direct_contact in docs/01.`);
    else {
      out.push(`NEEDS_DIRECT_CONTACT: ${directContactReason(d)}. Approval and export are blocked. Checklist:`);
      for (const line of directContactChecklist(d)) out.push(`  ${line}`);
    }
  }
  if (score.incompleteData.flag) {
    out.push(`INCOMPLETE_DATA: ${score.incompleteData.reason}. Score not raised (${score.incompleteData.notFoundPoints} points NOT_FOUND vs ${score.incompleteData.otherLostPoints} lost otherwise).`);
  }
  if (isFound(d.firm_type)) out.push(`firm_type source: ${d.firm_type.value.source ?? "model"} (${d.firm_type.value.primary})`);
  if (isFound(d.client_count_signal)) out.push(`client_count_signal (not scored): ${JSON.stringify(d.client_count_signal.value.text)}`);
  if (d.email_security_hint !== "NOT_FOUND") {
    out.push(`POSSIBLE EXISTING IT PROVIDER (internal only, never in emails): ${d.email_security_hint.note} (${d.email_security_hint.evidence_url})`);
  }
  return out;
}
