import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NOT_FOUND, type Dossier } from "@clearpath/shared";
import { leads } from "../src/db/schema";
import { makeHarness, PORT, WRITER_ANSWER } from "./fixtures/app-harness";
import { strongDossier } from "./fixtures/dossiers";

/**
 * Every path that ends without a clean sequence must leave a plain reason the lead page shows:
 * gates, tier C templates, validator-blocked drafts, unusable model output, spend cap, broken
 * settings, rejected requests, and a failure inside a background job.
 */
function insertLead(h: ReturnType<typeof makeHarness>, id: string, d: Dossier, tier: "A" | "B" | "C" = "B") {
  h.db.insert(leads).values({ id, source: "web", status: "extracted", tier, score: 60, gateStatus: d.gate.status, dossierJson: JSON.stringify(d) }).run();
}

const BAD = { emails: WRITER_ANSWER.emails.map((e) => (e.n === 1 ? { ...e, opening: "Great news for your firm!" } : e)) };

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

  it("tier C: a template sequence (no model call) is written and listed on the Sequences screen", async () => {
    const h = makeHarness();
    try {
      // A qualified lead that scores tier C (too few signals found).
      const c = strongDossier({ size_signal: NOT_FOUND, decision_maker: NOT_FOUND, people: [], services: NOT_FOUND, personal_email_domain_on_site: NOT_FOUND, client_portal_or_doc_exchange: NOT_FOUND, security_mention_search: "NOT_CHECKED" });
      insertLead(h, "L-c", { ...c, dns: { ...c.dns, dmarc_present: NOT_FOUND } }, "C");
      const w = await h.call("POST", "/api/leads/L-c/sequence");
      expect(w.status).toBe(200);
      const seq = (await h.call("GET", `/api/sequences/${w.json.id}`)).json;
      expect(seq).toMatchObject({ kind: "template", judgeRequired: false, tier: "C" });
      expect(seq.sequence.emails.every((e: { template: boolean }) => e.template)).toBe(true);
      const list = (await h.call("GET", "/api/sequences")).json;
      expect(list).toMatchObject([{ leadId: "L-c", kind: "template", tier: "C" }]);
      expect(h.calls.filter((c) => JSON.stringify(c.tools).includes("write_sequence"))).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("validator-blocked drafts are returned in full with their errors (both drafts kept), not hidden", async () => {
    const h = makeHarness({ writer: BAD });
    try {
      insertLead(h, "L-bad", strongDossier());
      const r = await h.call("POST", "/api/leads/L-bad/sequence");
      expect(r.status).toBe(200);
      expect(r.json.validationPass).toBe(false);
      expect(r.json.sequence.emails[0].body).toContain("Great news for your firm!");
      expect(r.json.issues.map((i: { code: string }) => i.code)).toContain("exclamation");
      expect(r.json.drafts).toHaveLength(2);
      expect(r.json.drafts[0].errors.length).toBeGreaterThan(0);
      expect((await h.call("GET", "/api/leads/L-bad")).json.lastWriteAttempt.detail).toMatch(/^Written, needs fixes: .*code validators failed/);
    } finally {
      h.cleanup();
    }
  });

  it("an unusable rewrite keeps the first draft on screen (the old behavior returned nothing)", async () => {
    const h = makeHarness({ writer: (n: number) => (n === 0 ? BAD : { oops: true }) });
    try {
      insertLead(h, "L-keep", strongDossier());
      const r = await h.call("POST", "/api/leads/L-keep/sequence");
      expect(r.status).toBe(200);
      expect(r.json.sequence.emails[0].body).toContain("Great news for your firm!");
      expect(r.json.drafts[1].formatProblem).toMatch(/writer output invalid/);
      expect((await h.call("GET", "/api/leads/L-keep")).json.lastWriteAttempt.detail).toMatch(/rewrite could not be used.*first draft is shown with its errors/);
    } finally {
      h.cleanup();
    }
  });

  it("two unusable answers fall back to the template emails, labeled, instead of nothing", async () => {
    const h = makeHarness({ writer: { oops: true } });
    try {
      insertLead(h, "L-tpl", strongDossier());
      const r = await h.call("POST", "/api/leads/L-tpl/sequence");
      expect(r.status).toBe(200);
      expect(r.json.kind).toBe("template");
      expect((await h.call("GET", "/api/leads/L-tpl")).json.lastWriteAttempt.detail).toMatch(/template emails are shown instead/);
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
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace('"cta_type": "checklist"', '"cta_type": "brochure"'));
      const r = await h.call("POST", "/api/leads/L-set/sequence");
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/01_offer_and_icp\.md clearpath:offer is invalid/);
      expect(r.json.error).not.toMatch(/\bat\s+\S+\.ts:\d+/);
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
    const h = makeHarness({ writer: () => {
      throw new Error("model endpoint unavailable");
    } });
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

