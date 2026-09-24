import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import PQueue from "p-queue";
import { leads, type LeadStatus } from "../db/schema";
import { researchPastedLead, researchWebLead } from "../pipeline/research";
import { leadOverride } from "../scoring/direct-contact";
import { generateSequence, logWriteAttempt } from "../write/generate";
import { researchDeps, writeDeps, type Services } from "./services";

export const MAX_URLS_PER_JOB = 5;

export type ItemState = "queued" | "researching" | "writing" | "done" | "failed" | "cancelled";

export interface JobItem {
  leadId: string;
  label: string;
  state: ItemState;
  /** Plain-language progress or error text. */
  message: string;
  leadStatus?: LeadStatus;
  tier?: string;
  sequenceStatus?: string;
}

export interface Job {
  id: string;
  createdAt: string;
  items: JobItem[];
  cancelRequested: boolean;
  finished: boolean;
}

export type JobInput =
  | { kind: "web"; urls: string[] }
  | { kind: "paste"; label: string; text: string; leadId?: string };

export class JobInputError extends Error {
  override name = "JobInputError";
}

/** "https://www.Smith-Tax.com/about" -> "lead-smith-tax-com". */
export function leadIdForUrl(url: string): string {
  const host = url.trim().replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0]!.toLowerCase().replace(/^www\./, "");
  return `lead-${host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}

export function leadIdForLabel(label: string): string {
  return `paste-${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "lead"}`;
}

/**
 * Background jobs, one lead at a time (p-queue, concurrency 1): research, then the sequence (tier C
 * and gated leads make no model calls). Status is kept in memory and polled by the UI. Cancel stops
 * before the next step; a step already running finishes (its spend is logged either way).
 */
export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly queue = new PQueue({ concurrency: 1 });

  constructor(private readonly services: Services) {}

  start(input: JobInput): Job {
    const items: JobItem[] =
      input.kind === "web"
        ? this.webItems(input.urls)
        : [{ leadId: input.leadId ?? leadIdForLabel(input.label), label: input.label.trim() || "pasted lead", state: "queued", message: "Waiting" }];
    if (input.kind === "paste" && input.text.trim().length < 20) throw new JobInputError("Paste at least a few sentences of text about the firm.");
    const job: Job = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), items, cancelRequested: false, finished: false };
    this.jobs.set(job.id, job);
    for (const item of items) void this.queue.add(() => this.run(job, item, input));
    void this.queue.onIdle().then(() => {
      if (job.items.every((i) => ["done", "failed", "cancelled"].includes(i.state))) job.finished = true;
    });
    return job;
  }

  private webItems(urls: string[]): JobItem[] {
    const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    if (clean.length === 0) throw new JobInputError("Enter at least one website address.");
    if (clean.length > MAX_URLS_PER_JOB) throw new JobInputError(`Enter at most ${MAX_URLS_PER_JOB} website addresses at a time.`);
    return clean.map((url) => ({ leadId: leadIdForUrl(url), label: url, state: "queued", message: "Waiting" }));
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  cancel(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.cancelRequested = true;
    for (const item of job.items) {
      if (item.state === "queued") {
        item.state = "cancelled";
        item.message = "Cancelled before it started";
      }
    }
    return job;
  }

  /** Resolves when every queued job has finished (tests). */
  idle(): Promise<void> {
    return this.queue.onIdle();
  }

  private async run(job: Job, item: JobItem, input: JobInput): Promise<void> {
    if (job.cancelRequested || item.state === "cancelled") return;
    const s = this.services;
    try {
      item.state = "researching";
      item.message = input.kind === "web" ? "Reading the website and checking DNS" : "Reading the pasted text";
      const rdeps = researchDeps(s);
      const r =
        input.kind === "web"
          ? await researchWebLead(item.leadId, item.label, rdeps)
          : await researchPastedLead(item.leadId, input.text, rdeps);
      item.leadStatus = r.status;
      item.tier = r.score.tier;
      if (r.status === "failed") {
        item.state = "failed";
        item.message = `Research failed: ${r.error ?? "unknown error"}`;
        return;
      }
      if (job.cancelRequested) {
        item.state = "cancelled";
        item.message = "Cancelled after research (no sequence written)";
        return;
      }
      item.state = "writing";
      item.message = r.score.tier === "C" ? "Assembling the emails (fallback line, no model call)" : "Assembling the emails and writing the personal line";
      const gateApproved = s.db.select({ v: leads.gateApproved }).from(leads).where(eq(leads.id, item.leadId)).get()?.v ?? false;
      const g = await generateSequence(item.leadId, r.dossier, r.score.tier, writeDeps(s), { gateApproved, directContactOverride: leadOverride(s.db, item.leadId) });
      item.sequenceStatus = g.status;
      item.state = "done";
      item.message = g.status === "no_sequence" ? `Researched; no sequence (${g.reason})` : `Done: sequence ${g.status === "passed" ? "ready for review" : "needs fixes"}`;
    } catch (err) {
      const wasWriting = item.state === "writing";
      // A failed write leaves its reason on the lead page, not only in this job's status.
      if (wasWriting) logWriteAttempt(s.db, item.leadId, `Not written: ${plainError(err)}`);
      item.state = "failed";
      item.message = wasWriting ? `Research done, but the sequence was not written: ${plainError(err)}` : plainError(err);
    }
  }
}

/** One readable line for the UI; never a stack trace. */
export function plainError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "BudgetExceededError" || err.name === "SpendCapError") return err.message;
    return err.message.split("\n")[0]!.slice(0, 300);
  }
  return String(err).slice(0, 300);
}
