import { NOT_FOUND, type Dossier } from "@clearpath/shared";

/** A dossier saved by a much older version, missing core fields (gate, fit, DNS). It needs a fresh run. */
export class OutdatedDossierError extends Error {
  override name = "OutdatedDossierError";
}

const CORE_FIELDS = ["gate", "us_location", "target_industry_fit", "dns", "decision_maker", "latest_dated_content", "security_mention_search"] as const;

/**
 * Reads a dossier saved in the leads table. Dossiers saved before later schema additions lack the
 * newer code-derived fields; those get their empty defaults (the same defaults the schema applies),
 * so older leads still open. Facts are never invented: every added field is NOT_FOUND or empty.
 * A dossier missing core fields is refused with a plain message (research it again).
 */
export function readStoredDossier(json: string): Dossier {
  const d = JSON.parse(json) as Partial<Dossier> & Record<string, unknown>;
  const missing = CORE_FIELDS.filter((k) => d[k] === undefined);
  if (missing.length > 0) {
    throw new OutdatedDossierError("This lead was researched by an older version of the app. Import it again to refresh its research.");
  }
  return {
    declined_automated_access: false,
    firm_name_candidates: [],
    client_count_signal: NOT_FOUND,
    public_email_kind: NOT_FOUND,
    email_security_hint: NOT_FOUND,
    portal_mention_search: "NOT_CHECKED",
    injection_findings: [],
    ...d,
  } as Dossier;
}

/** Like readStoredDossier, but null for an outdated dossier (lists skip the details instead of failing). */
export function tryReadStoredDossier(json: string): Dossier | null {
  try {
    return readStoredDossier(json);
  } catch (err) {
    if (err instanceof OutdatedDossierError) return null;
    throw err;
  }
}
