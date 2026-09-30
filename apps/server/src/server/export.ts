import { isFound, type Dossier, type Sequence } from "@clearpath/shared";
import { tryReadStoredDossier } from "../pipeline/stored-dossier";
import type { LeadsDb } from "../db/supa-leads";
import type { SequencesDb } from "../db/supa-sequences";
import type { SuppressionDb } from "../db/supa-suppression";
import { contactWarning, publicAddress } from "../scoring/direct-contact";
import { renderEmail } from "../validators/email";
import type { WriteDeps } from "../write/generate";
import { emptySettingsUsed, renderSettings, renderSignature } from "../write/merge";

// ---- suppression list ----

export interface Suppression {
  id: number;
  kind: "email" | "domain";
  value: string;
}

/** "Jane@Firm.com" -> email "jane@firm.com"; "mailto:x@y.com" -> email; "https://www.firm.com/x" -> domain "firm.com". */
export function normalizeSuppression(input: string): { kind: "email" | "domain"; value: string } | null {
  const raw = input.trim().toLowerCase().replace(/^mailto:/, "");
  if (!raw) return null;
  if (raw.includes("@")) {
    return /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(raw) ? { kind: "email", value: raw } : null;
  }
  const host = raw.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? { kind: "domain", value: host } : null;
}

export function listSuppressions(suppressionDb: SuppressionDb): Promise<Suppression[]> {
  return suppressionDb.list();
}

export async function addSuppression(suppressionDb: SuppressionDb, input: string): Promise<Suppression> {
  const n = normalizeSuppression(input);
  if (!n) throw new Error(`"${input}" is not an email address or a domain.`);
  const existing = await suppressionDb.findByValue(n.value);
  if (existing) return existing;
  return suppressionDb.insert(n);
}

export function removeSuppression(suppressionDb: SuppressionDb, id: number): Promise<void> {
  return suppressionDb.delete(id);
}

/** The matching suppression entry for an address (exact email, or its domain or a parent domain), if any. */
export function suppressedBy(list: Suppression[], address: string, extraDomains: string[] = []): Suppression | null {
  const email = address.trim().toLowerCase();
  const domains = [email.slice(email.indexOf("@") + 1), ...extraDomains.map((d) => d.toLowerCase().replace(/^www\./, ""))].filter(Boolean);
  return (
    list.find((s) => s.kind === "email" && s.value === email) ??
    list.find((s) => s.kind === "domain" && domains.some((d) => d === s.value || d.endsWith(`.${s.value}`))) ??
    null
  );
}

// ---- export ----

/** "ready": rows with an email address only. "drafts": every approved row, addressed or not. */
export type ExportMode = "ready" | "drafts";

export interface ExportRow {
  lead_id: string;
  firm_name: string;
  /** Empty when no public address was found (drafts mode only). Never guessed or constructed. */
  to_email: string;
  /** "Y" when the row has an address to send to, else "N". */
  send_ready: "Y" | "N";
  /** Why reply odds are lower or the row cannot be sent yet; empty for a named contact. */
  contact_note: string;
  subject_a: string;
  subject_b: string;
  /** subject: emails 2-5, the subject used if the email starts a new thread (docs/09); "" if none. */
  emails: { n: number; send_day: number; subject: string; text: string }[];
}

export interface ExportResult {
  /** Reasons the whole export is refused. Empty when allowed. */
  blocked: string[];
  rows: ExportRow[];
  /** Approved leads left out, with the reason (suppressed; no address in ready mode). */
  excluded: { lead_id: string; firm_name: string; reason: string }[];
  csv: string;
  mode: ExportMode;
  /** Rows each mode would export (suppressed leads never count). */
  readyCount: number;
  draftCount: number;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const EXPORT_COLUMNS = [
  "lead_id",
  "firm_name",
  "to_email",
  "send_ready",
  "contact_note",
  "subject_a",
  "subject_b",
  ...[1, 2, 3, 4, 5].flatMap((n) => [`email_${n}_send_day`, ...(n > 1 ? [`email_${n}_subject`] : []), `email_${n}_text`]),
];

export function toCsv(rows: ExportRow[]): string {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const r of rows) {
    const cells: (string | number)[] = [r.lead_id, r.firm_name, r.to_email, r.send_ready, r.contact_note, r.subject_a, r.subject_b];
    for (let n = 1; n <= 5; n++) {
      const e = r.emails.find((x) => x.n === n);
      cells.push(e?.send_day ?? "", ...(n > 1 ? [e?.subject ?? ""] : []), e?.text ?? "");
    }
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * The export: approved sequences only. Refused as a whole while the signature/footer settings are
 * incomplete, or while checklist_ready is false and an approved sequence offers the checklist. The
 * suppression list is checked before each row; a suppressed lead is left out and reported. Rows hold
 * only the rendered emails, the address, and the contact note, never dossier notes. "ready" exports
 * rows with an address; "drafts" exports every approved row (send_ready N without an address).
 */
export async function buildExport(
  leadsDb: LeadsDb,
  sequencesDb: SequencesDb,
  suppressionDb: SuppressionDb,
  deps: Pick<WriteDeps, "offer" | "templates">,
  mode: ExportMode = "ready",
): Promise<ExportResult> {
  const offer = deps.offer;
  const latest = new Map<string, { status: string; sequence: Sequence | null }>();
  for (const row of await sequencesDb.listAll()) {
    latest.set(row.leadId, { status: row.status, sequence: (row.sequenceJson as Sequence | null) ?? null });
  }
  const approved = [...latest.entries()].filter(([, v]) => v.status === "approved" && v.sequence);

  const blocked: string[] = [];
  const missing = (["sender_name", "sender_title", "company_name", "company_website", "opt_out_line", "physical_address"] as const).filter((k) => offer[k].trim() === "");
  if (missing.length > 0) blocked.push(`Fill in these settings first: ${missing.join(", ")}. Every email needs the full signature, the opt-out line, and a mailing address.`);
  // docs/09 merge settings: offer, booking_link, and region always; any other one an approved email uses.
  const used = new Set(approved.flatMap(([, v]) => v.sequence!.emails.flatMap((e) => emptySettingsUsed([e.body, e.subject_a ?? ""].join("\n"), offer))));
  const mergeMissing = [
    ...(!offer.founding_client_offer?.trim() ? ["founding_client_offer (the {{offer}} in email 4)"] : []),
    ...(!offer.booking_link.trim() ? ["booking_link"] : []),
    ...(!offer.region.trim() ? ["region"] : []),
    ...[...used].filter((f) => !["offer", "booking_link", "region"].includes(f)),
  ];
  if (mergeMissing.length > 0) blocked.push(`Fill in these settings first: ${mergeMissing.join(", ")}. The emails use them.`);
  if (!offer.checklist_ready && approved.some(([, v]) => v.sequence!.emails.some((e) => e.n === 3))) {
    blocked.push("Email 3 offers the checklist, but checklist_ready is off in Settings. Turn it on once the checklist can be sent.");
  }
  if (approved.length === 0) blocked.push("No approved sequences yet. Approve a sequence first.");
  if (blocked.length > 0) return { blocked, rows: [], excluded: [], csv: "", mode, readyCount: 0, draftCount: 0 };

  const list = await listSuppressions(suppressionDb);
  const all: ExportRow[] = [];
  const excluded: ExportResult["excluded"] = [];
  for (const [leadId, v] of approved) {
    const lead = await leadsDb.get(leadId);
    const d = lead?.dossierJson ? tryReadStoredDossier(lead.dossierJson) : null;
    const firm = d && isFound(d.firm_name) ? d.firm_name.value : leadId;
    if (!d) {
      excluded.push({ lead_id: leadId, firm_name: firm, reason: "no current research on file (import it again)" });
      continue;
    }
    const address = publicAddress(d);
    // Suppression is checked before anything else about the row.
    const hit = address ? suppressedBy(list, address, [d.domain]) : suppressedBy(list, "", [d.domain]);
    if (hit) {
      excluded.push({ lead_id: leadId, firm_name: firm, reason: `on the suppression list (${hit.value})` });
      continue;
    }
    const seq = v.sequence!;
    const e1 = seq.emails.find((e) => e.n === 1);
    const signature = renderSignature(deps.templates.signature, offer);
    all.push({
      lead_id: leadId,
      firm_name: firm,
      to_email: address ?? "",
      send_ready: address ? "Y" : "N",
      contact_note: contactWarning(d) ?? "",
      subject_a: e1?.subject_a ? renderSettings(e1.subject_a, offer) : "",
      subject_b: e1?.subject_b ? renderSettings(e1.subject_b, offer) : "",
      emails: seq.emails.map((e) => ({ n: e.n, send_day: e.send_day, subject: e.n > 1 && e.subject_a ? renderSettings(e.subject_a, offer) : "", text: renderEmail(e.body, offer, signature) })),
    });
  }
  const ready = all.filter((r) => r.send_ready === "Y");
  if (mode === "ready") {
    for (const r of all) if (r.send_ready === "N") excluded.push({ lead_id: r.lead_id, firm_name: r.firm_name, reason: `${r.contact_note} (included in the Drafts export)` });
  }
  const rows = mode === "ready" ? ready : all;
  return { blocked: [], rows, excluded, csv: toCsv(rows), mode, readyCount: ready.length, draftCount: all.length };
}
