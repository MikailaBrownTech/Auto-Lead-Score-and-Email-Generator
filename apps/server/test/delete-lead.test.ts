import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leadEvents, leads, pages, runs, sequences } from "../src/db/schema";
import { deleteLead, deleteLeads, LeadNotFoundError } from "../src/pipeline/delete-lead";
import { makeHarness } from "./fixtures/app-harness";
import { strongDossier } from "./fixtures/dossiers";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

function saveLead(id: string, domain: string) {
  db.insert(leads)
    .values({ id, source: "web", status: "extracted", score: 60, tier: "B", gateStatus: "qualified", dossierJson: JSON.stringify(strongDossier({ domain })) })
    .run();
}

function savePage(domain: string, path = "/") {
  const url = `https://${domain}${path}`;
  db.insert(pages)
    .values({
      requestedUrl: url,
      url,
      contentType: "text/html",
      title: "t",
      text: "text",
      hiddenText: "",
      linksJson: "[]",
      textSha256: "a".repeat(64),
      rawSha256: "b".repeat(64),
      bytes: 4,
      truncated: false,
      nearEmpty: false,
      fetchedAt: new Date().toISOString(),
    })
    .run();
}

describe("deleteLead", () => {
  it("removes the lead row (its dossier), its sequences, and its event log", () => {
    saveLead("L1", "onlyl1.example");
    db.insert(sequences).values({ leadId: "L1", tier: "B", status: "blocked", sequenceJson: "null", validationJson: "{}" }).run();
    db.insert(leadEvents).values({ leadId: "L1", kind: "write_attempt", detail: "x" }).run();

    deleteLead(db, "L1");

    expect(db.select().from(leads).where(eq(leads.id, "L1")).get()).toBeUndefined();
    expect(db.select().from(sequences).where(eq(sequences.leadId, "L1")).all()).toEqual([]);
    expect(db.select().from(leadEvents).where(eq(leadEvents.leadId, "L1")).all()).toEqual([]);
  });

  it("throws LeadNotFoundError for a lead that does not exist", () => {
    expect(() => deleteLead(db, "nope")).toThrow(LeadNotFoundError);
  });

  it("leaves the cost ledger (runs) untouched, even though it references the deleted lead", () => {
    saveLead("L1", "onlyl1.example");
    db.insert(runs).values({ model: "m", callType: "write", leadId: "L1", status: "ok", costUsd: 0.05 }).run();

    deleteLead(db, "L1");

    const row = db.select().from(runs).where(eq(runs.leadId, "L1")).get();
    expect(row?.costUsd).toBe(0.05);
  });

  it("deletes cached pages for the lead's domain when no other lead shares it", () => {
    saveLead("L1", "onlyl1.example");
    savePage("onlyl1.example", "/");
    savePage("onlyl1.example", "/about");

    const r = deleteLead(db, "L1");

    expect(r.pagesDeleted).toBe(2);
    expect(db.select().from(pages).all()).toEqual([]);
  });

  it("keeps cached pages when another lead's dossier still uses the same domain", () => {
    saveLead("L1", "shared.example");
    saveLead("L2", "shared.example");
    savePage("shared.example", "/");

    const r = deleteLead(db, "L1");

    expect(r.pagesDeleted).toBe(0);
    expect(db.select().from(pages).all()).toHaveLength(1);
    expect(db.select().from(leads).where(eq(leads.id, "L2")).get()).toBeDefined();
  });

  it("never touches another domain's cached pages", () => {
    saveLead("L1", "onlyl1.example");
    savePage("onlyl1.example");
    savePage("other.example");

    deleteLead(db, "L1");

    expect(db.select().from(pages).all().map((p) => p.requestedUrl)).toEqual(["https://other.example/"]);
  });

  it("a lead with no research yet (no dossier) deletes cleanly with no page cleanup", () => {
    db.insert(leads).values({ id: "L1", source: "web", status: "new" }).run();
    const r = deleteLead(db, "L1");
    expect(r.pagesDeleted).toBe(0);
    expect(db.select().from(leads).where(eq(leads.id, "L1")).get()).toBeUndefined();
  });
});

describe("deleteLeads (bulk)", () => {
  it("deletes every id given, skipping ones that no longer exist", () => {
    saveLead("L1", "one.example");
    saveLead("L2", "two.example");
    savePage("one.example");
    savePage("two.example");

    const r = deleteLeads(db, ["L1", "gone", "L2"]);

    expect(r.deleted).toEqual(["L1", "L2"]);
    expect(r.pagesDeleted).toBe(2);
    expect(db.select().from(leads).all()).toEqual([]);
  });
});

describe("DELETE /api/leads/:id and POST /api/leads/bulk-delete", () => {
  it("deletes one lead and its sequence; a second delete 404s", async () => {
    const h = makeHarness();
    try {
      await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] });
      await h.jobs.idle();
      const id = "lead-smithtax-example";
      expect((await h.call("GET", `/api/leads/${id}`)).status).toBe(200);

      const del = await h.call("DELETE", `/api/leads/${id}`);
      expect(del.status).toBe(200);
      expect(del.json).toMatchObject({ deleted: [id] });

      expect((await h.call("GET", `/api/leads/${id}`)).status).toBe(404);
      expect((await h.call("GET", "/api/leads")).json).toEqual([]);

      const again = await h.call("DELETE", `/api/leads/${id}`);
      expect(again.status).toBe(404);
    } finally {
      h.cleanup();
    }
  });

  it("bulk-delete: skips missing ids; an empty selection is refused", async () => {
    const h = makeHarness();
    try {
      await h.call("POST", "/api/jobs", { mode: "paste", label: "Doe Tax", text: "Jane Doe, owner: jane@doetax.example\nBookkeeping services." });
      await h.jobs.idle();
      const id = "paste-doe-tax";

      const empty = await h.call("POST", "/api/leads/bulk-delete", { ids: [] });
      expect(empty.status).toBe(400);

      const bulk = await h.call("POST", "/api/leads/bulk-delete", { ids: [id, "no-such-lead"] });
      expect(bulk.status).toBe(200);
      expect(bulk.json).toMatchObject({ deleted: [id] });
      expect((await h.call("GET", "/api/leads")).json).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
