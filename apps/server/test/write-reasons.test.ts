import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_FOUND, PERSONAL_LINE_TOOL_NAME, type Dossier } from "@clearpath/shared";
import { leads } from "../src/db/schema";
import { makeHarness, PORT } from "./fixtures/app-harness";
import { strongDossier } from "./fixtures/dossiers";

/**
 * Every path that ends without a sequence leaves a plain reason the lead page shows. Anything the code
 * can repair (a model line that fails the checks, an unreadable answer, an API error, the spend cap)
 * is repaired with the docs/09 fallback line and a note, never shown as a failure.
 */
function insertLead(h: ReturnType<typeof makeHarness>, id: string, d: Dossier, tier: "A" | "B" | "C" = "B") {
  h.db.insert(leads).values({ id, source: "web", status: "extracted", tier, score: 60, gateStatus: d.gate.status, dossierJson: JSON.stringify(d) }).run();
}
const lineCalls = (h: ReturnType<typeof makeHarness>) => h.calls.filter((c) => JSON.stringify(c.tools).includes(PERSONAL_LINE_TOOL_NAME));

describe("why no sequence was written: always visible on the lead page", { timeout: 60_000 }, () => {
  it("out_of_icp and needs_review: 409 with a plain reason and how to proceed; logged; the override clears it", async () => {
    const h = makeHarness();
    try {
      insertLead(h, "L-out", strongDossier({ gate: { status: "out_of_icp", reasons: ["staff count 150 is above max_staff_for_sequence 60"] } }));
      insertLead(h, "L-rev", strongDossier({ gate: { status: "needs_review", reasons: ["exclusion signal government_or_nonprofit_only"] } }));
      const out = await h.call("POST", "/api/leads/L-out/sequence");
      expect(out.status).toBe(409);
      expect(out.json.error).toBe("Not written: this lead is out of ICP (staff count 150 is above max_staff_for_sequence 60). Approve it with a reason to write anyway.");
      const detail = (await h.call("GET", "/api/leads/L-out")).json;
      expect(detail.notWrittenReason).toMatch(/^Not written: this lead is out of ICP/);
      expect(detail.lastWriteAttempt.detail).toMatch(/^Not written: this lead is out of ICP/);
      expect((await h.call("GET", "/api/leads/L-rev")).json.notWrittenReason).toMatch(/^Not written: this lead needs review .*Approve it with a reason/);

      const approved = (await h.call("POST", "/api/leads/L-out/gate-override", { reason: "Small office despite the listed staff" })).json;
      expect(approved.notWrittenReason).toBeNull();
      const written = await h.call("POST", "/api/leads/L-out/sequence");
      expect(written.status).toBe(200);
      expect(written.json.sequence.emails).toHaveLength(5);
    } finally {
      h.cleanup();
    }
  });

  it("tier C: docs/09 copy with the fallback line (no model call), listed on the Sequences screen", async () => {
    const h = makeHarness();
    try {
      const c = strongDossier({ size_signal: NOT_FOUND, decision_maker: NOT_FOUND, people: [], services: NOT_FOUND, personal_email_domain_on_site: NOT_FOUND, client_portal_or_doc_exchange: NOT_FOUND, security_mention_search: "NOT_CHECKED" });
      insertLead(h, "L-c", { ...c, dns: { ...c.dns, dmarc_present: NOT_FOUND } }, "C");
      const w = await h.call("POST", "/api/leads/L-c/sequence");
      expect(w.status).toBe(200);
      const seq = (await h.call("GET", `/api/sequences/${w.json.id}`)).json;
      expect(seq).toMatchObject({ kind: "template", judgeRequired: false, tier: "C", rewritable: [], personalLine: { source: "fallback" } });
      expect((await h.call("GET", "/api/sequences")).json).toMatchObject([{ leadId: "L-c", kind: "template", tier: "C" }]);
      expect(lineCalls(h)).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it.each([
    ["a line that fails the checks", { line: { personal_line: "Great news for your firm!" } }, /did not pass the checks/],
    ["an unreadable answer", { line: { oops: true } }, /could not be read/],
    [
      "an API error",
      {
        line: () => {
          throw new Error("model endpoint unavailable");
        },
      },
      /the model was not used \(.*model endpoint unavailable/,
    ],
    ["the monthly spend cap", { capUsd: 0.000001 }, /the model was not used \(.*cap/i],
  ])("%s: repaired with the fallback line, approvable, and the note says why (not an error)", async (_label, opts, note) => {
    const h = makeHarness(opts as Parameters<typeof makeHarness>[0]);
    try {
      insertLead(h, "L-fb", strongDossier());
      const r = await h.call("POST", "/api/leads/L-fb/sequence");
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ validationPass: true, personalLine: { source: "fallback" } });
      expect(r.json.personalLine.note).toMatch(note);
      expect(r.json.sequence.emails[0].body).not.toContain("Great news");
      expect((await h.call("GET", "/api/leads/L-fb")).json.lastWriteAttempt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("broken settings (docs/01 block does not parse): plain 400 and the reason stays on the lead page", async () => {
    const h = makeHarness();
    try {
      insertLead(h, "L-set", strongDossier());
      const f = path.join(h.docsDir, "01_offer_and_icp.md");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"checklist_ready": false', '"checklist_ready": "no"'));
      const r = await h.call("POST", "/api/leads/L-set/sequence");
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/01_offer_and_icp\.md clearpath:offer is invalid/);
      expect(r.json.error).not.toMatch(/\bat\s+\S+\.ts:\d+/);
      expect((await h.call("GET", "/api/leads/L-set")).json.lastWriteAttempt.detail).toMatch(/^Not written: /);
    } finally {
      h.cleanup();
    }
  });

  it("a request without the local token is refused (401) before anything runs", async () => {
    const h = makeHarness();
    try {
      insertLead(h, "L-auth", strongDossier());
      const res = await h.app.request(`http://127.0.0.1:${PORT}/api/leads/L-auth/sequence`, { method: "POST", headers: { host: `127.0.0.1:${PORT}` } });
      expect(res.status).toBe(401);
      const evil = await h.app.request(`http://127.0.0.1:${PORT}/api/leads/L-auth/sequence`, { method: "POST", headers: { host: `127.0.0.1:${PORT}`, origin: "https://evil.example" } });
      expect(evil.status).toBe(403);
    } finally {
      h.cleanup();
    }
  });

  it("a background job: a model error is repaired; a broken docs/09 file fails the write with a plain reason", async () => {
    const h = makeHarness({
      line: () => {
        throw new Error("model endpoint unavailable");
      },
    });
    try {
      const job = (await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] })).json;
      await h.jobs.idle();
      expect((await h.call("GET", `/api/jobs/${job.id}`)).json.items[0]).toMatchObject({ state: "done", sequenceStatus: "passed" });

      const f = path.join(h.docsDir, "09_sequences.md");
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("## Email 5", "## Notes"));
      await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example/other"] });
      await h.jobs.idle();
      const again = (await h.call("POST", "/api/leads/lead-smithtax-example/sequence"));
      expect(again.status).toBe(400);
      expect(again.json.error).toMatch(/09_sequences\.md: missing "## Email 5"/);
      expect((await h.call("GET", "/api/leads/lead-smithtax-example")).json.lastWriteAttempt.detail).toMatch(/^Not written: .*09_sequences\.md/);
    } finally {
      h.cleanup();
    }
  });
});
