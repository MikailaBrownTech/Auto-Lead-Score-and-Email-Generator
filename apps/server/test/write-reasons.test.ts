import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_FOUND, WRITER_TOOL_NAME, type Dossier } from "@clearpath/shared";
import { leads } from "../src/db/schema";
import { makeHarness, PORT } from "./fixtures/app-harness";
import { strongDossier } from "./fixtures/dossiers";
import { writerAnswerFor } from "./fixtures/write-deps";

/**
 * Every path that ends without a clean sequence leaves a plain reason the lead page shows: gates,
 * validator-blocked drafts (shown in full with their errors), unusable model output, the spend cap,
 * broken settings or docs, rejected requests, and a failure inside a background job.
 */
function insertLead(h: ReturnType<typeof makeHarness>, id: string, d: Dossier, tier: "A" | "B" | "C" = "B") {
  h.db.insert(leads).values({ id, source: "web", status: "extracted", tier, score: 60, gateStatus: d.gate.status, dossierJson: JSON.stringify(d) }).run();
}
const writerCalls = (h: ReturnType<typeof makeHarness>) => h.calls.filter((c) => JSON.stringify(c.tools).includes(WRITER_TOOL_NAME));
/** A writer answer whose email 3 states a rule (a validator error the rewrite cannot fix here). */
const RULE_CLAIM = (() => {
  const a = writerAnswerFor('"firm_name": "Smith Tax Services" where you put [[APPROVED]] in email 2');
  a.emails[2]!.body = "The FTC Safeguards Rule requires a written plan. Want the checklist?";
  return a;
})();

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

  it("tier C: the docs/09 fixed copy (no model call), listed on the Sequences screen", async () => {
    const h = makeHarness();
    try {
      const c = strongDossier({ size_signal: NOT_FOUND, decision_maker: NOT_FOUND, people: [], services: NOT_FOUND, personal_email_domain_on_site: NOT_FOUND, client_portal_or_doc_exchange: NOT_FOUND, security_mention_search: "NOT_CHECKED" });
      insertLead(h, "L-c", { ...c, dns: { ...c.dns, dmarc_present: NOT_FOUND } }, "C");
      const w = await h.call("POST", "/api/leads/L-c/sequence");
      expect(w.status).toBe(200);
      const seq = (await h.call("GET", `/api/sequences/${w.json.id}`)).json;
      expect(seq).toMatchObject({ kind: "template", judgeRequired: false, tier: "C", rewritable: [] });
      expect((await h.call("GET", "/api/sequences")).json).toMatchObject([{ leadId: "L-c", kind: "template", tier: "C" }]);
      expect(h.calls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("validator errors that survive the one rewrite: the draft is shown in full with its errors, both drafts kept", async () => {
    const h = makeHarness({ writer: RULE_CLAIM });
    try {
      insertLead(h, "L-bad", strongDossier());
      const r = await h.call("POST", "/api/leads/L-bad/sequence");
      expect(r.status).toBe(200);
      expect(r.json.validationPass).toBe(false);
      expect(r.json.sequence.emails[2].body).toMatch(/Safeguards Rule requires/);
      expect(r.json.issues.map((i: { code: string }) => i.code)).toContain("unapproved_regulatory_sentence");
      expect(r.json.drafts).toHaveLength(2);
      expect(writerCalls(h)).toHaveLength(2);
      expect((await h.call("GET", "/api/leads/L-bad")).json.lastWriteAttempt.detail).toMatch(/^Written, needs fixes: .*validator errors remain after the rewrite/);
    } finally {
      h.cleanup();
    }
  });

  it("two unusable writer answers: 409 with a plain reason that stays on the lead page", async () => {
    const h = makeHarness({ writer: { oops: true } });
    try {
      insertLead(h, "L-bad", strongDossier());
      const r = await h.call("POST", "/api/leads/L-bad/sequence");
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/^Not written: the writer's answers could not be used/);
      expect((await h.call("GET", "/api/leads/L-bad")).json.lastWriteAttempt.detail).toMatch(/could not be used/);
    } finally {
      h.cleanup();
    }
  });

  it("spend-cap refusal: a plain 409 and the reason stays on the lead page", async () => {
    const h = makeHarness({ capUsd: 0.000001 });
    try {
      insertLead(h, "L-cap", strongDossier());
      const r = await h.call("POST", "/api/leads/L-cap/sequence");
      expect(r.status).toBe(409);
      expect(r.json.error).toMatch(/cap/i);
      expect((await h.call("GET", "/api/leads/L-cap")).json.lastWriteAttempt.detail).toMatch(/^Not written: .*cap/i);
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

  it("a failure while a background job writes: the job says so and the lead page keeps the reason", async () => {
    const h = makeHarness({
      writer: () => {
        throw new Error("model endpoint unavailable");
      },
    });
    try {
      const job = (await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] })).json;
      await h.jobs.idle();
      const item = (await h.call("GET", `/api/jobs/${job.id}`)).json.items[0];
      expect(item.state).toBe("failed");
      expect(item.message).toMatch(/^Research done, but the sequence was not written: /);
      const detail = (await h.call("GET", "/api/leads/lead-smithtax-example")).json;
      expect(detail.lastWriteAttempt.detail).toMatch(/^Not written: /);
      expect(detail.sequenceId).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
