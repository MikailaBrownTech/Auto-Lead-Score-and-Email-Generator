import { NOT_FOUND, type Dossier, type Sequence } from "@clearpath/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leads } from "../src/db/schema";
import { contactWarning } from "../src/scoring/direct-contact";
import { addSuppression, buildExport } from "../src/server/export";
import { validateSequence } from "../src/validators/email";
import { approveSequence, firstNameFor, generateSequence, templateSequence } from "../src/write/generate";
import { writerMessage } from "../src/write/prompt";
import { writerInput } from "../src/write/writer";
import { ev, strongDossier } from "./fixtures/dossiers";
import { READY_OFFER, scripted, style, templates, testWriteDeps } from "./fixtures/write-deps";

// strongDossier: Smith Tax Services, decision maker Jane Smith, public address jane@smithtax.example (tied to her).
const generic = strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox" });
const unattributed = strongDossier({ public_contact_email: ev({ address: "frontdesk@smithtax.example", owner_name: null }, "frontdesk@smithtax.example"), public_email_kind: "unattributed" });
const gmail = strongDossier({ public_contact_email: ev({ address: "smithtaxoffice@gmail.com", owner_name: null }, "smithtaxoffice@gmail.com"), public_email_kind: "unattributed" });
const noEmail = strongDossier({ public_contact_email: NOT_FOUND, public_email_kind: NOT_FOUND });
const mismatch = strongDossier({ public_contact_email: ev({ address: "john.phillips@smithtax.example", owner_name: null }, "john.phillips@smithtax.example"), public_email_kind: "named_person" });

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("never a named greeting unless the address is tied to that person", () => {
  const cases: [string, Dossier][] = [
    ["generic inbox", generic],
    ["unattributed inbox", unattributed],
    ["gmail inbox", gmail],
    ["no public email", noEmail],
    ["an address tied to someone else", mismatch],
  ];

  it.each(cases)("%s: the writer is told no name and a role-based opener; the tier C copy opens with the role-based line", async (_label, d) => {
    expect(firstNameFor(d, null)).toBeNull();
    const { deps } = testWriteDeps(db);
    expect(writerMessage(writerInput(d, deps, firstNameFor(d, null)))).toMatch(/greeting rule: no named contact/);
    const c = templateSequence("L1", d, deps, null);
    expect(c.emails[0]!.body.split("\n")[0]).toBe("Quick question for whoever looks after IT and client data at Smith Tax Services:");
    db.insert(leads).values({ id: "L1", source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();
    const g = await generateSequence("L1", d, "B", deps);
    for (const e of [...c.emails, ...g.sequence!.emails]) expect(e.body).not.toMatch(/\bJane\b/);
  });

  it("the tied first name only, and never after an override", () => {
    expect(firstNameFor(strongDossier(), null)).toBe("Jane");
    expect(firstNameFor(strongDossier(), { reason: "Solo practice; owner's inbox", at: "2026-09-24T12:00:00Z" })).toBeNull();
  });

  it("the validator refuses a name on an untied address", () => {
    const { deps } = testWriteDeps(db);
    for (const d of [generic, unattributed, noEmail, mismatch]) {
      const s: Sequence = templateSequence("L1", d, deps, null);
      s.emails[0] = { ...s.emails[0]!, body: s.emails[0]!.body.replace(/^[^\n]*/, "Hi Jane,") };
      expect(validateSequence(s, { style, offer: READY_OFFER, dossier: d }).issues.map((i) => i.code)).toContain("greeting_contact_mismatch");
    }
  });
});

describe("no named contact: drafting, approval, and export proceed", () => {
  const save = (id: string, d: Dossier) => db.insert(leads).values({ id, source: "web", status: "no_named_contact", dossierJson: JSON.stringify({ ...d, lead_id: id }) }).run();

  it("warning texts, in plain words", () => {
    expect(contactWarning(generic)).toBe("generic inbox: lower reply odds");
    expect(contactWarning(gmail)).toBe("address not tied to a named person: lower reply odds");
    expect(contactWarning(noEmail)).toBe("no public email; add before sending");
    expect(contactWarning(strongDossier())).toBeNull();
  });

  it("a lead with no email at all is written and approved", async () => {
    save("L-none", noEmail);
    const { deps } = testWriteDeps(db, scripted(), { offer: READY_OFFER });
    const g = await generateSequence("L-none", noEmail, "B", deps);
    expect(g).toMatchObject({ status: "passed", contactWarning: "no public email; add before sending" });
    approveSequence(db, g.sequenceId!);
  });

  it("export: 'Ready to send' has rows with an address; 'Drafts' has every approved row with send_ready and contact_note", async () => {
    save("L-none", noEmail);
    save("L-generic", strongDossier({ ...generic, domain: "genericfirm.example" }));
    save("L-named", strongDossier({ domain: "namedfirm.example" }));
    const { deps } = testWriteDeps(db, scripted(), { offer: READY_OFFER });
    for (const [id, d] of [["L-none", noEmail], ["L-generic", generic], ["L-named", strongDossier()]] as const) {
      const g = await generateSequence(id, d, "B", deps);
      approveSequence(db, g.sequenceId!);
    }

    const r = buildExport(db, { offer: READY_OFFER, templates }, "ready");
    expect(r).toMatchObject({ blocked: [], mode: "ready", readyCount: 2, draftCount: 3 });
    expect(r.rows.map((x) => [x.lead_id, x.to_email, x.send_ready, x.contact_note])).toEqual([
      ["L-generic", "info@smithtax.example", "Y", "generic inbox: lower reply odds"],
      ["L-named", "jane@smithtax.example", "Y", ""],
    ]);
    expect(r.excluded).toEqual([{ lead_id: "L-none", firm_name: "Smith Tax Services", reason: "no public email; add before sending (included in the Drafts export)" }]);

    const drafts = buildExport(db, { offer: READY_OFFER, templates }, "drafts");
    expect(drafts.rows).toHaveLength(3);
    // Never a guessed or constructed address.
    expect(drafts.rows.find((x) => x.lead_id === "L-none")).toMatchObject({ to_email: "", send_ready: "N", contact_note: "no public email; add before sending" });
    const [header, ...lines] = drafts.csv.trim().split("\r\n");
    expect(header!.split(",").slice(0, 5)).toEqual(["lead_id", "firm_name", "to_email", "send_ready", "contact_note"]);
    expect(header).toContain("email_4_subject");
    expect(lines.find((l) => l.startsWith("L-none,"))).toMatch(/^L-none,Smith Tax Services,,N,no public email; add before sending,/);
    // Settings merge fields are filled in the CSV; the signature block follows docs/09.
    expect(drafts.csv).toContain(READY_OFFER.booking_link);
    expect(drafts.csv).toContain(`${READY_OFFER.sender_title}, ${READY_OFFER.company_name}`);
    expect(drafts.csv).not.toMatch(/\{\{/);
  });

  it("export is refused while offer, booking_link, or region is empty", async () => {
    save("L-named", strongDossier());
    const { deps } = testWriteDeps(db, scripted(), { offer: READY_OFFER });
    approveSequence(db, (await generateSequence("L-named", strongDossier(), "B", deps)).sequenceId!);
    const r = buildExport(db, { offer: { ...READY_OFFER, founding_client_offer: null, booking_link: "", region: "" }, templates });
    expect(r.blocked.join(" ")).toMatch(/founding_client_offer \(the \{\{offer\}\} in email 4\), booking_link, region/);
  });

  it("the suppression list is still checked first in Drafts mode (by domain when there is no address)", async () => {
    save("L-none", noEmail);
    const { deps } = testWriteDeps(db, scripted(), { offer: READY_OFFER });
    approveSequence(db, (await generateSequence("L-none", noEmail, "B", deps)).sequenceId!);
    addSuppression(db, noEmail.domain);
    const drafts = buildExport(db, { offer: READY_OFFER, templates }, "drafts");
    expect(drafts.rows).toEqual([]);
    expect(drafts.excluded[0]!.reason).toMatch(/^on the suppression list/);
  });
});
