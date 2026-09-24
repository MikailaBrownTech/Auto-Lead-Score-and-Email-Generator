/**
 * Shapes of the local JSON API (server <-> browser). Types only. The API key and model prompts never
 * appear in any of these.
 */
import type { Dossier } from "./dossier";
import type { JudgeOutput, Sequence, Tier } from "./sequence";

export interface LeadFlags {
  generic_inbox: boolean;
  needs_direct_contact: boolean;
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
}

export interface LeadEventView {
  kind: string;
  detail: string;
  createdAt: string;
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
  directContact: { needed: boolean; reason: string | null; checklist: string[]; override: { reason: string; at: string } | null };
  /** Never used in emails or writer input. */
  internalNotes: { incompleteData: string | null; emailSecurityHint: string | null; clientCount: string | null };
  events: LeadEventView[];
  sequenceId: number | null;
  sequenceStatus: string | null;
  /** Why "Write sequence" cannot run now (a gate that has not been approved), in plain words; null when it can. */
  notWrittenReason: string | null;
  /** The newest write attempt that did not end in a clean sequence (not written, error, needs fixes), if newer than the sequence. */
  lastWriteAttempt: { at: string; detail: string } | null;
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
  approvalBlockers: string[];
  exportBlockers: string[];
  /** Code-inserted approved sentences (docs/02), to show apart from model-written text. */
  approvedSentences: { id: string; text: string }[];
  /** Emails the model may rewrite for this tier. */
  rewritable: number[];
  wordLimits: Record<string, number>;
  breakupSentences: { min: number; max: number };
  subjectMaxWords: number;
  signature: string[];
  /** "template": every email is fixed docs/09 text (no model call). "custom": at least one model-written email. */
  kind: "template" | "custom";
  /** Every writer draft of this sequence, with the validator errors it got (blocked drafts included). */
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
  blocked: string[];
  rowCount: number;
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
  cta_type: "checklist" | "scorecard";
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

/** Every error from the API: one plain sentence. */
export interface ApiError {
  error: string;
}
