/**
 * Shapes of the local JSON API (server <-> browser). Types only. The API key and model prompts never
 * appear in any of these.
 */
import type { Dossier } from "./dossier";
import type { JudgeOutput, Sequence, Tier } from "./sequence";

/** Contact flags are warnings only: they never block drafting, approval, or export. */
export interface LeadFlags {
  generic_inbox: boolean;
  /** An address was found, but it is neither tied to a named person nor a role inbox. */
  unattributed_inbox: boolean;
  no_public_email: boolean;
  incomplete_data: boolean;
  declined_automated_access: boolean;
}

export interface LeadRow {
  id: string;
  source: "web" | "pasted";
  firm: string | null;
  type: string | null;
  city: string | null;
  state: string | null;
  score: number | null;
  tier: Tier | null;
  gate: string | null;
  status: string;
  flags: LeadFlags;
  costUsd: number;
  sequenceStatus: string | null;
  updatedAt: string;
}

export interface CriterionView {
  key: string;
  label: string;
  group: string;
  points: number;
  max: number;
  reason: string;
  /** Scored 0 only because a fact was NOT_FOUND (unknown, not a negative finding). */
  dataMissing: boolean;
}

export interface LeadEventView {
  kind: string;
  detail: string;
  createdAt: string;
}

export interface BriefingLineView {
  topic: "fit" | "contact" | "services" | "security" | "wisp" | "freshness" | "access";
  text: string;
}

/** Plain-language summary at the top of the lead page, composed by code from fields already computed. */
export interface BriefingView {
  lines: BriefingLineView[];
  note: string;
}

export interface LeadDetail {
  id: string;
  source: "web" | "pasted";
  inputUrl: string | null;
  status: string;
  error: string | null;
  score: number;
  tier: Tier;
  fitPoints: number;
  tierCapped: boolean;
  gateApproved: boolean;
  dossier: Dossier;
  breakdown: CriterionView[];
  costUsd: number;
  flags: LeadFlags;
  /**
   * Named when the public address is tied to a named person. Otherwise a warning (never a blocker),
   * optional public sources to improve reply odds, and the optional override.
   */
  /** greeting: "Hi Jane," when the address is tied to that person; null = email 1 opens with the role-based line. */
  contact: { named: boolean; greeting: string | null; warning: string | null; checklist: string[]; override: { reason: string; at: string } | null };
  /** Never used in emails or writer input. */
  internalNotes: { incompleteData: string | null; emailSecurityHint: string | null; clientCount: string | null };
  events: LeadEventView[];
  sequenceId: number | null;
  sequenceStatus: string | null;
  /** Why "Write sequence" cannot run now (a gate that has not been approved), in plain words; null when it can. */
  notWrittenReason: string | null;
  /** The newest write attempt that did not end in a clean sequence (not written, error, needs fixes), if newer than the sequence. */
  lastWriteAttempt: { at: string; detail: string } | null;
  briefing: BriefingView;
}

export interface ValidationIssueView {
  severity: "error" | "warning";
  email: number | null;
  code: string;
  message: string;
}

export interface SequenceView {
  id: number;
  leadId: string;
  firm: string | null;
  tier: Tier;
  status: string;
  sequence: Sequence;
  issues: ValidationIssueView[];
  validationPass: boolean;
  judgeRequired: boolean;
  /** The judge result for the current content, or null if it has not been run on it. */
  judge: JudgeOutput | null;
  /** A lead without a named contact (plain words); a warning, never an approval blocker. */
  contactWarning: string | null;
  exportBlockers: string[];
  /** Code-inserted approved sentences (docs/02), to show apart from other text. */
  approvedSentences: { id: string; text: string }[];
  /** Emails the writer may rewrite: all five, every tier. */
  rewritable: number[];
  wordLimits: Record<string, number>;
  subjectMaxWords: number;
  signature: string[];
  /** Emails with settings merge fields ({{offer}}, {{booking_link}}, ...) filled in, as they will be sent. */
  rendered: { n: number; subject_a: string | null; subject_b: string | null; body: string }[];
  /** "template": the old docs/09 fixed copy, from before every tier was model-written. "custom": written by the model or edited by you. */
  kind: "template" | "custom";
  /** Every writer draft of this sequence (first draft, rewrite), with the validator errors it got. */
  drafts: { attempt: number; formatProblem: string | null; errors: ValidationIssueView[] }[];
}

export interface SequenceListItem {
  id: number;
  leadId: string;
  firm: string | null;
  tier: Tier;
  status: string;
  kind: "template" | "custom";
  createdAt: string;
}

export interface JobItemView {
  leadId: string;
  label: string;
  state: "queued" | "researching" | "writing" | "done" | "failed" | "cancelled";
  message: string;
  leadStatus?: string;
  tier?: string;
  sequenceStatus?: string;
}

export interface JobView {
  id: string;
  createdAt: string;
  items: JobItemView[];
  cancelRequested: boolean;
  finished: boolean;
}

export interface ExportView {
  /** "ready": rows with an address. "drafts": every approved row (send_ready N without an address). */
  mode: "ready" | "drafts";
  blocked: string[];
  rowCount: number;
  readyCount: number;
  draftCount: number;
  excluded: { lead_id: string; firm_name: string; reason: string }[];
  csv: string;
}

/** Settings editable in the UI (docs/01 offer block, written back with a backup). */
export interface OfferSettingsView {
  sender_name: string;
  sender_title: string;
  company_name: string;
  company_website: string;
  opt_out_line: string;
  physical_address: string;
  founding_client_offer: string;
  booking_link: string;
  region: string;
  company_one_liner: string;
  checklist_ready: boolean;
  include_dns_observation: boolean;
}

export interface SuppressionView {
  id: number;
  kind: "email" | "domain";
  value: string;
}

export interface SpendView {
  month: string;
  spentUsd: number;
  reservedUsd: number;
  capUsd: number;
  leadsWithSpend: number;
  avgPerLeadUsd: number;
}

/** Response of DELETE /api/leads/:id and POST /api/leads/bulk-delete. */
export interface DeleteLeadsView {
  deleted: string[];
  /** Cached pages removed with it (only pages tied to no other lead's domain). */
  pagesDeleted: number;
}

/** Every error from the API: one plain sentence. */
export interface ApiError {
  error: string;
}
