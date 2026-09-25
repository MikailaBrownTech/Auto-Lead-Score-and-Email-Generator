import { Hono, type Context } from "hono";
import type { CacheHealth, DeleteLeadsView, ExportView, JobView, OfferSettingsView, SpendView } from "@clearpath/shared";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { leadEvents, leads } from "../db/schema";
import { BlockError } from "../docs/blocks";
import { DOCS_DIR, loadOffer, saveBlock } from "../docs/loader";
import { loadTemplates } from "../docs/templates";
import { cacheHealth } from "../llm/cache-health";
import { deleteLead, deleteLeads, LeadNotFoundError } from "../pipeline/delete-lead";
import { OutdatedDossierError } from "../pipeline/stored-dossier";
import type { SpendGate } from "../llm/spend-gate";
import { leadOverride, MIN_OVERRIDE_REASON, overrideDirectContact } from "../scoring/direct-contact";
import { ApprovalBlockedError, approveSequence, generateSequence, logWriteAttempt } from "../write/generate";
import { checkEdits, loadSequenceContext, rewriteOne, runJudge, saveEdits, SequenceError, sequenceState } from "../write/edit";
import { addSuppression, buildExport, listSuppressions, removeSuppression, type ExportMode } from "./export";
import { JobInputError, plainError, type JobRunner } from "./jobs";
import { localGuard, type LocalGuardOptions } from "./local-guard";
import { writeDeps, type Services } from "./services";
import { costByLead, leadDetail, listLeads, listSequences, NotFoundError, sequenceView, sequenceViewFrom } from "./views";

export interface AppDeps {
  guard: LocalGuardOptions;
  gate: SpendGate;
  db: Db;
  services: Services;
  jobs: JobRunner;
}

/** A plain-language 4xx error for the UI. */
export class UserError extends Error {
  override name = "UserError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const OFFER_FIELDS = ["sender_name", "sender_title", "company_name", "company_website", "opt_out_line", "physical_address", "founding_client_offer", "booking_link", "region", "company_one_liner", "checklist_ready", "include_dns_observation"] as const;

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new UserError("The request was not valid JSON.");
  }
}

function reasonOf(input: unknown): string {
  const reason = typeof input === "string" ? input.trim() : "";
  if (reason.length < MIN_OVERRIDE_REASON) throw new UserError(`Type a reason of at least ${MIN_OVERRIDE_REASON} characters. It is kept in the lead's log.`);
  return reason;
}

function idParam(c: Context): number {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new UserError("That sequence id is not valid.");
  return id;
}

type Edit = { n: number; subject_a?: string | null; subject_b?: string | null; body: string };
function editsOf(input: unknown): Edit[] {
  const emails = (input as { emails?: unknown })?.emails;
  if (!Array.isArray(emails)) throw new UserError("Send the emails to check.");
  return emails.map((e: Record<string, unknown>) => {
    if (typeof e.n !== "number" || typeof e.body !== "string") throw new UserError("Each email needs a number and a body.");
    return { n: e.n, body: e.body, subject_a: (e.subject_a as string | null | undefined) ?? null, subject_b: (e.subject_b as string | null | undefined) ?? null };
  });
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const { db, services: s, jobs } = deps;
  const docsDir = s.docsDir ?? DOCS_DIR;

  app.use("/api/*", localGuard(deps.guard));

  // Plain one-line errors only; never a stack trace.
  app.onError((err, c) => {
    if (err instanceof UserError) return c.json({ error: err.message }, err.status);
    if (err instanceof NotFoundError || err instanceof LeadNotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof OutdatedDossierError) return c.json({ error: err.message }, 409);
    if (err instanceof JobInputError || err instanceof SequenceError || err instanceof BlockError) return c.json({ error: plainError(err) }, 400);
    if (err instanceof ApprovalBlockedError) return c.json({ error: err.message }, 409);
    if (err.name === "SpendCapError" || err.name === "BudgetExceededError") return c.json({ error: err.message }, 409);
    return c.json({ error: `Something went wrong: ${plainError(err)}` }, 500);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/spend", (c) => {
    const costs = [...costByLead(db).values()];
    const leadsWithSpend = costs.filter((x) => x > 0).length;
    const body: SpendView = {
      month: deps.gate.currentMonth(),
      spentUsd: deps.gate.spentThisMonthUsd(),
      reservedUsd: deps.gate.reservedUsd(),
      capUsd: deps.gate.capUsd,
      leadsWithSpend,
      avgPerLeadUsd: leadsWithSpend ? costs.reduce((a, b) => a + b, 0) / leadsWithSpend : 0,
    };
    return c.json(body);
  });

  app.get("/api/cache-health", (c) => {
    const body: CacheHealth = cacheHealth(db);
    return c.json(body);
  });

  // ---- jobs ----
  app.post("/api/jobs", async (c) => {
    const b = await body<{ mode?: string; urls?: unknown; label?: unknown; text?: unknown }>(c);
    const job =
      b.mode === "paste"
        ? jobs.start({ kind: "paste", label: String(b.label ?? ""), text: String(b.text ?? "") })
        : jobs.start({ kind: "web", urls: Array.isArray(b.urls) ? b.urls.map(String) : String(b.urls ?? "").split(/\s+/) });
    return c.json(job satisfies JobView, 202);
  });
  app.get("/api/jobs/:id", (c) => {
    const job = jobs.get(c.req.param("id"));
    if (!job) throw new UserError("That job was not found (jobs are kept until the app restarts).", 404);
    return c.json(job satisfies JobView);
  });
  app.post("/api/jobs/:id/cancel", (c) => {
    const job = jobs.cancel(c.req.param("id"));
    if (!job) throw new UserError("That job was not found.", 404);
    return c.json(job satisfies JobView);
  });

  // ---- leads ----
  app.get("/api/leads", (c) => c.json(listLeads(db)));
  app.get("/api/leads/:id", (c) => c.json(leadDetail(s, c.req.param("id"))));

  /** Re-runs the lead in paste mode with the owner's name, email, and page text. */
  app.post("/api/leads/:id/paste", async (c) => {
    const id = c.req.param("id");
    const b = await body<{ ownerName?: string; ownerEmail?: string; text?: string }>(c);
    const name = (b.ownerName ?? "").trim();
    const email = (b.ownerEmail ?? "").trim();
    const text = (b.text ?? "").trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new UserError("That email address does not look right.");
    if (!text && !(name && email)) throw new UserError("Paste the owner's name and email, the page text, or both.");
    // Name and address on one line, so the evidence quote ties the address to the person.
    const composed = [name && email ? `${name}, owner: ${email}` : name || email, text].filter(Boolean).join("\n\n");
    const lead = db.select({ id: leads.id }).from(leads).where(eq(leads.id, id)).get();
    if (!lead) throw new UserError(`Lead ${id} was not found.`, 404);
    db.insert(leadEvents).values({ leadId: id, kind: "paste_rerun", detail: `re-run in paste mode (${composed.length} characters pasted)` }).run();
    const job = jobs.start({ kind: "paste", label: id, text: composed, leadId: id });
    return c.json(job satisfies JobView, 202);
  });

  app.post("/api/leads/:id/override-contact", async (c) => {
    const id = c.req.param("id");
    const b = await body<{ reason?: unknown }>(c);
    try {
      overrideDirectContact(db, id, reasonOf(b.reason));
    } catch (err) {
      if (err instanceof UserError) throw err;
      throw new UserError(plainError(err));
    }
    return c.json(leadDetail(s, id));
  });

  app.post("/api/leads/:id/gate-override", async (c) => {
    const id = c.req.param("id");
    const reason = reasonOf((await body<{ reason?: unknown }>(c)).reason);
    const lead = db.select({ id: leads.id }).from(leads).where(eq(leads.id, id)).get();
    if (!lead) throw new UserError(`Lead ${id} was not found.`, 404);
    db.update(leads).set({ gateApproved: true, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))` }).where(eq(leads.id, id)).run();
    db.insert(leadEvents).values({ leadId: id, kind: "gate_override", detail: reason }).run();
    return c.json(leadDetail(s, id));
  });

  /** Writes (or rewrites) the whole sequence for a lead now. */
  app.post("/api/leads/:id/sequence", async (c) => {
    const id = c.req.param("id");
    const l = db.select().from(leads).where(eq(leads.id, id)).get();
    if (!l?.dossierJson || !l.tier) throw new UserError(`Lead ${id} has no research yet.`, 404);
    const detail = leadDetail(s, id);
    let g;
    let wd;
    try {
      wd = writeDeps(s);
      g = await generateSequence(id, detail.dossier, detail.tier, wd, { gateApproved: l.gateApproved, directContactOverride: leadOverride(db, id) });
    } catch (err) {
      // Broken docs (settings, docs/09) or anything else the code cannot repair: keep the reason on the lead page, then report it.
      logWriteAttempt(db, id, `Not written: ${plainError(err)}`);
      throw err;
    }
    if (g.status === "no_sequence" || !g.sequenceId || !g.sequence) throw new UserError(g.reason, 409);
    return c.json(sequenceView(db, g.sequenceId, wd));
  });

  /** Deletes one lead: its dossier (part of the lead row), sequences, and event log; cached pages too, if no other lead still uses that domain. */
  app.delete("/api/leads/:id", (c) => {
    const id = c.req.param("id");
    const result = deleteLead(db, id);
    return c.json({ deleted: [id], pagesDeleted: result.pagesDeleted } satisfies DeleteLeadsView);
  });

  /** Bulk delete from the Leads table. Ids that are already gone are skipped, not an error. */
  app.post("/api/leads/bulk-delete", async (c) => {
    const b = await body<{ ids?: unknown }>(c);
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (ids.length === 0) throw new UserError("No leads were selected.");
    const result = deleteLeads(db, ids);
    return c.json(result satisfies DeleteLeadsView);
  });

  // ---- sequences ----
  app.get("/api/sequences", (c) => c.json(listSequences(db)));
  app.get("/api/sequences/:id", (c) => c.json(sequenceView(db, idParam(c), writeDeps(s))));

  /** Live check while typing: validates the edits without saving. */
  app.post("/api/sequences/:id/check", async (c) => {
    const id = idParam(c);
    const wd = writeDeps(s);
    const edits = editsOf(await body(c));
    const r = checkEdits(db, id, edits, wd);
    const ctx = loadSequenceContext(db, id, wd);
    return c.json(sequenceViewFrom(id, ctx.leadId, ctx.tier, ctx.dossier, r.status, r.sequence, r, wd, ctx.drafts));
  });

  app.put("/api/sequences/:id", async (c) => {
    const id = idParam(c);
    const wd = writeDeps(s);
    saveEdits(db, id, editsOf(await body(c)), wd);
    return c.json(sequenceView(db, id, wd));
  });

  app.post("/api/sequences/:id/judge", async (c) => {
    const id = idParam(c);
    const wd = writeDeps(s);
    await runJudge(db, id, wd);
    return c.json(sequenceView(db, id, wd));
  });

  app.post("/api/sequences/:id/rewrite", async (c) => {
    const id = idParam(c);
    const n = Number((await body<{ n?: unknown }>(c)).n);
    if (![1, 2, 3, 4, 5].includes(n)) throw new UserError("Choose an email from 1 to 5.");
    const wd = writeDeps(s);
    await rewriteOne(db, id, n, wd);
    return c.json(sequenceView(db, id, wd));
  });

  /** Approval re-checks the current content: validators and judge must both pass. A missing named contact never blocks. */
  app.post("/api/sequences/:id/approve", (c) => {
    const id = idParam(c);
    const wd = writeDeps(s);
    const ctx = loadSequenceContext(db, id, wd);
    const state = sequenceState(ctx, ctx.sequence, ctx.judge, wd);
    if (!state.validation.pass) throw new UserError("Fix the validator errors before approving.", 409);
    if (state.judgeRequired && !state.judge) throw new UserError("Run the judge on the current text before approving.", 409);
    if (state.status !== "passed") throw new UserError("The judge listed unsupported claims. Fix them and run the judge again.", 409);
    approveSequence(db, id);
    return c.json(sequenceView(db, id, wd));
  });

  // ---- export ----
  const exportMode = (c: Context): ExportMode => (c.req.query("mode") === "drafts" ? "drafts" : "ready");
  app.get("/api/export", (c) => {
    const r = buildExport(db, { offer: loadOffer(docsDir), templates: loadTemplates(docsDir) }, exportMode(c));
    const view: ExportView = { mode: r.mode, blocked: r.blocked, rowCount: r.rows.length, readyCount: r.readyCount, draftCount: r.draftCount, excluded: r.excluded, csv: r.csv };
    return c.json(view);
  });
  app.get("/api/export.csv", (c) => {
    const r = buildExport(db, { offer: loadOffer(docsDir), templates: loadTemplates(docsDir) }, exportMode(c));
    if (r.blocked.length > 0) throw new UserError(r.blocked.join(" "), 409);
    const name = `clearpath-${r.mode === "drafts" ? "drafts" : "ready-to-send"}-${new Date().toISOString().slice(0, 10)}.csv`;
    return c.body(r.csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` });
  });

  // ---- settings ----
  /** founding_client_offer is null in docs/01 while empty; the form shows "". */
  const settingsView = (offer: ReturnType<typeof loadOffer>) =>
    Object.fromEntries(OFFER_FIELDS.map((k) => [k, k === "founding_client_offer" ? (offer[k] ?? "") : offer[k]])) as unknown as OfferSettingsView;
  app.get("/api/settings", (c) => c.json({ offer: settingsView(loadOffer(docsDir)), suppressions: listSuppressions(db) }));
  /** Saves the footer fields through the safe docs/01 write-back (validated, backed up, round-tripped). */
  app.put("/api/settings/offer", async (c) => {
    const b = await body<Partial<OfferSettingsView>>(c);
    const current = loadOffer(docsDir);
    const next = { ...current };
    for (const k of OFFER_FIELDS) if (k in b) (next as Record<string, unknown>)[k] = (b as Record<string, unknown>)[k];
    if (typeof next.founding_client_offer === "string" && next.founding_client_offer.trim() === "") next.founding_client_offer = null;
    try {
      saveBlock("offer", next, { docsDir, ...(s.backupDir ? { backupDir: s.backupDir } : {}) });
    } catch (err) {
      throw new UserError(`Settings were not saved: ${plainError(err)}`);
    }
    const saved = loadOffer(docsDir);
    return c.json({ offer: settingsView(saved), suppressions: listSuppressions(db) });
  });
  app.post("/api/suppressions", async (c) => {
    const value = String((await body<{ value?: unknown }>(c)).value ?? "");
    try {
      addSuppression(db, value);
    } catch (err) {
      throw new UserError(plainError(err));
    }
    return c.json(listSuppressions(db));
  });
  app.delete("/api/suppressions/:id", (c) => {
    removeSuppression(db, Number(c.req.param("id")));
    return c.json(listSuppressions(db));
  });

  app.all("/api/*", (c) => c.json({ error: "Unknown API address." }, 404));
  return app;
}
