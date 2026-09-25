import { describe, expect, it } from "vitest";
import { NOT_FOUND } from "@clearpath/shared";
import { leads } from "../src/db/schema";
import { ev, strongDossier } from "./fixtures/dossiers";
import { DOE_TEXT, makeHarness } from "./fixtures/app-harness";

/**
 * End to end through the local API, offline: saved HTML fixtures and recorded model answers.
 * import -> research -> write -> approve -> export, with a suppressed lead left out of the export.
 */
describe("end to end: import -> research -> write -> approve -> export", { timeout: 60_000 }, () => {
  it("exports approved leads only, checks the suppression list first, and never leaks internal notes", async () => {
    const h = makeHarness();
    try {
      // Settings: the footer must be complete and the checklist ready before anything exports.
      const blockedFirst = await h.call("GET", "/api/export");
      expect(blockedFirst.json.blocked.join(" ")).toMatch(/opt_out_line, physical_address/);
      const saved = await h.call("PUT", "/api/settings/offer", { opt_out_line: "Reply no and I will not email again.", physical_address: "1 Main St, Columbus, OH 43215", checklist_ready: true, founding_client_offer: "half off the first three months", booking_link: "https://cal.example.com/clearpath", region: "Columbus-area" });
      expect(saved.status).toBe(200);
      expect(saved.json.offer).toMatchObject({ opt_out_line: "Reply no and I will not email again.", checklist_ready: true });

      // Import a website and a pasted lead; poll the job until it finishes.
      const web = await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] });
      expect(web.status).toBe(202);
      const paste = await h.call("POST", "/api/jobs", { mode: "paste", label: "Doe Tax", text: DOE_TEXT });
      await h.jobs.idle();
      const webJob = (await h.call("GET", `/api/jobs/${web.json.id}`)).json;
      const pasteJob = (await h.call("GET", `/api/jobs/${paste.json.id}`)).json;
      expect(webJob.items[0]).toMatchObject({ leadId: "lead-smithtax-example", state: "done" });
      expect(pasteJob.items[0]).toMatchObject({ leadId: "paste-doe-tax", state: "done" });

      // Leads table: Smith's only address is office@ (a generic inbox): labeled no_named_contact, a warning only.
      const rows = (await h.call("GET", "/api/leads")).json as { id: string; status: string; flags: Record<string, boolean> }[];
      const smith = rows.find((r) => r.id === "lead-smithtax-example")!;
      expect(smith).toMatchObject({ status: "no_named_contact", flags: { generic_inbox: true, no_public_email: false } });
      expect(rows.find((r) => r.id === "paste-doe-tax")!.status).toBe("extracted");

      // No override needed: the checklist is optional, email 1 opens with the role-based line, and it can be approved.
      let detail = (await h.call("GET", "/api/leads/lead-smithtax-example")).json;
      expect(detail.contact).toMatchObject({ named: false, greeting: null, warning: "generic inbox: lower reply odds", override: null });
      expect(detail.contact.checklist.join(" ")).toMatch(/Secretary of State/);
      const seq = (await h.call("GET", `/api/sequences/${detail.sequenceId}`)).json;
      expect(seq.validationPass).toBe(true);
      expect(seq.contactWarning).toBe("generic inbox: lower reply odds");
      const approved = await h.call("POST", `/api/sequences/${detail.sequenceId}/approve`);
      expect(approved.status).toBe(200);
      expect(approved.json.status).toBe("approved");
      // The override stays available (typed reason, logged) and clears the label, but was not required.
      expect((await h.call("POST", "/api/leads/lead-smithtax-example/override-contact", { reason: "short" })).status).toBe(400);
      detail = (await h.call("POST", "/api/leads/lead-smithtax-example/override-contact", { reason: "Solo office; office@ is read by the owner" })).json;
      expect(detail).toMatchObject({ status: "extracted", contact: { override: { reason: "Solo office; office@ is read by the owner" } } });
      expect(detail.events.map((e: { kind: string }) => e.kind)).toContain("direct_contact_override");

      const doe = (await h.call("GET", "/api/leads/paste-doe-tax")).json;
      expect((await h.call("POST", `/api/sequences/${doe.sequenceId}/approve`)).status).toBe(200);

      // Suppress the pasted lead's domain: it is left out of the export, with the reason shown.
      const list = (await h.call("POST", "/api/suppressions", { value: "https://www.doetax.example/" })).json;
      expect(list).toMatchObject([{ kind: "domain", value: "doetax.example" }]);
      const exp = (await h.call("GET", "/api/export")).json;
      expect(exp.blocked).toEqual([]);
      expect(exp.rowCount).toBe(1);
      expect(exp.excluded).toEqual([{ lead_id: "paste-doe-tax", firm_name: "Doe Tax Service", reason: "on the suppression list (doetax.example)" }]);
      expect(exp.csv).toContain("office@smithtax.example");
      expect(exp.csv).not.toMatch(/doetax/i);
      expect(exp.csv).toContain("Reply no and I will not email again.");
      expect(exp.csv).toContain("ClearPath IT");
      // Generic inbox: a role-based opener written by the model, sendable, with the contact note; the booking link filled in.
      expect(exp.csv).toContain("Quick question for whoever handles client data at Smith Tax Services:");
      expect(exp.csv).toContain("https://cal.example.com/clearpath");
      expect(exp.csv).not.toMatch(/\{\{|\[\[/);
      expect(exp.csv).toContain("office@smithtax.example,Y,generic inbox: lower reply odds,");

      const file = await h.call("GET", "/api/export.csv");
      expect(file.status).toBe(200);
      expect(file.headers.get("content-disposition")).toMatch(/attachment; filename="clearpath-ready-to-send-/);
      expect(file.text).toBe(exp.csv);

      // No evidence quote ever reached a writer or judge message.
      for (const p of h.calls.filter((c) => c.tools?.some((t) => "name" in t && (t.name === "write_sequence" || t.name === "record_judgment")))) {
        const text = JSON.stringify(p.messages);
        expect(text).not.toMatch(/evidence_quote|evidence_url|Jane Smith, EA/);
      }
    } finally {
      h.cleanup();
    }
  });

  it("gives plain errors, never stack traces", async () => {
    const h = makeHarness();
    try {
      const tooMany = await h.call("POST", "/api/jobs", { mode: "web", urls: ["a.example", "b.example", "c.example", "d.example", "e.example", "f.example"] });
      expect(tooMany).toMatchObject({ status: 400, json: { error: "Enter at most 5 website addresses at a time." } });
      const missing = await h.call("GET", "/api/leads/nope");
      expect(missing.status).toBe(404);
      expect(missing.json.error).not.toMatch(/\bat\s+\S+\.ts:\d+/);
      // A lead saved by a much older version: listed as outdated, and its page says to import it again.
      h.db.insert(leads).values({ id: "L-old", source: "web", status: "extracted", dossierJson: JSON.stringify({ lead_id: "L-old", firm_name: "NOT_FOUND" }) }).run();
      expect((await h.call("GET", "/api/leads")).json.find((l: { id: string }) => l.id === "L-old").status).toBe("outdated_research");
      expect(await h.call("GET", "/api/leads/L-old")).toMatchObject({ status: 409, json: { error: expect.stringMatching(/older version.*Import it again/) } });
      const badSettings = await h.call("PUT", "/api/settings/offer", { checklist_ready: "no" });
      expect(badSettings.status).toBe(400);
      expect(badSettings.json.error).toMatch(/^Settings were not saved/);
    } finally {
      h.cleanup();
    }
  });

  it("internal notes (incomplete_data, email_security_hint, client_count_signal) never reach the writer, the judge, or the CSV", async () => {
    const h = makeHarness();
    try {
      await h.call("PUT", "/api/settings/offer", { opt_out_line: "Reply no to stop.", physical_address: "1 Main St", checklist_ready: true, founding_client_offer: "half off the first three months", booking_link: "https://cal.example.com/clearpath", region: "Columbus-area" });
      const d = strongDossier({
        size_signal: NOT_FOUND,
        decision_maker: NOT_FOUND,
        people: [],
        services: NOT_FOUND,
        phone_or_contact_form: NOT_FOUND,
        client_count_signal: ev({ count: 900, text: "Over 900 local businesses served" }, "Over 900 local businesses served"),
        email_security_hint: {
          rua_domains: ["itpro-example.net"],
          ruf_domains: [],
          outside_domains: ["itpro-example.net"],
          evidence_url: "dns:TXT _dmarc.smithtax.example",
          note: "possible existing IT provider: DMARC reports go to itpro-example.net",
        },
      });
      h.db.insert(leads).values({ id: "L-notes", source: "web", status: "extracted", tier: "B", score: 60, gateStatus: "qualified", dossierJson: JSON.stringify(d) }).run();
      const detail = (await h.call("GET", "/api/leads/L-notes")).json;
      expect(detail.internalNotes.emailSecurityHint).toMatch(/IT provider/);
      expect(detail.internalNotes.clientCount).toMatch(/900/);
      expect(detail.internalNotes.incompleteData).toMatch(/paste mode/);

      const seq = await h.call("POST", "/api/leads/L-notes/sequence");
      expect(seq.status).toBe(200);
      await h.call("POST", `/api/sequences/${seq.json.id}/judge`);
      expect((await h.call("POST", `/api/sequences/${seq.json.id}/approve`)).status).toBe(200);
      const exp = (await h.call("GET", "/api/export")).json;
      expect(exp.rowCount).toBe(1);

      const forbidden = /itpro-example|IT provider|DMARC reports|900 local businesses|client_count|incomplete|paste mode/i;
      // A clean first draft: one writer call and one judge call, plus the on-demand judge run above.
      const modelCalls = h.calls.filter((c) => c.tools?.some((t) => "name" in t && (t.name === "write_sequence" || t.name === "record_judgment")));
      expect(modelCalls.map((c) => (c.tools![0] as { name: string }).name)).toEqual(["write_sequence", "record_judgment", "record_judgment"]);
      for (const c of modelCalls) expect(JSON.stringify(c.messages)).not.toMatch(forbidden);
      expect(exp.csv).not.toMatch(forbidden);
    } finally {
      h.cleanup();
    }
  });
});
