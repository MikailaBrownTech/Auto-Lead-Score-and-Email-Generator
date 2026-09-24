/**
 * Exit codes for the live scripts. Expected lead outcomes (no_named_contact, needs_review,
 * out_of_icp, declined_automated_access, incomplete_data, a blocked sequence) exit 0; only real
 * errors exit non-zero, always with a printed "exit N because: ..." line.
 */
import type { LeadStatus } from "../src/db/schema";

export function exitWith(code: number, because?: string): never {
  if (code !== 0) console.log(`exit ${code} because: ${because ?? "unknown error"}`);
  process.exit(code);
}

/** Unexpected exceptions become a clear non-zero exit instead of a bare stack trace. */
export function installExitHandlers(): void {
  const fail = (err: unknown) => exitWith(1, `unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
}

/** Lead statuses that are real errors (everything else is an expected outcome). */
export const ERROR_STATUSES: ReadonlySet<LeadStatus> = new Set(["failed"]);

type LeadOutcome = { leadId: string; status: LeadStatus; error: string | null };

/** 0 for expected outcomes; 1 with the reason when any lead hit a real error. */
export function exitDecision(results: LeadOutcome[]): { code: number; because: string | null } {
  const errors = results.filter((r) => ERROR_STATUSES.has(r.status));
  if (errors.length === 0) return { code: 0, because: null };
  return { code: 1, because: errors.map((r) => `${r.leadId} ${r.status}${r.error ? `: ${r.error}` : ""}`).join("; ") };
}

export function exitForLeads(results: LeadOutcome[]): never {
  const d = exitDecision(results);
  exitWith(d.code, d.because ?? undefined);
}
