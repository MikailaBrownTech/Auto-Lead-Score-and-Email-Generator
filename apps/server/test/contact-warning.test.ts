import { NEUTRAL_GREETING_STYLES, NOT_FOUND, type Dossier, type OfferConfig, type Sequence, type SequenceEmail } from "@clearpath/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leads } from "../src/db/schema";
import { loadApprovedSentences, loadEvidence, loadOffer, loadStyle, loadWriterFacts } from "../src/docs/loader";
import { loadTemplates } from "../src/docs/templates";
import { contactPlan, leadGreeting, neutralGreeting } from "../src/scoring/contact";
import { contactWarning } from "../src/scoring/direct-contact";
import { addSuppression, buildExport } from "../src/server/export";
import { validateSequence } from "../src/validators/email";
import { approveSequence, generateSequence, type WriteDeps } from "../src/write/generate";
import { loadPersonaHeadings } from "../src/write/prompt";
import { ev, strongDossier } from "./fixtures/dossiers";

const style = loadStyle();
const offer = loadOffer();
const ready: OfferConfig = { ...offer, opt_out_line: "Reply no to stop.", physical_address: "1 Main St, Columbus, OH", checklist_ready: true };

// strongDossier: Smith Tax Services, decision maker Jane Smith, public address jane@smithtax.example (tied to her).
const generic = strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox" });
const unattributed = strongDossier({ public_contact_email: ev({ address: "frontdesk@smithtax.example", owner_name: null }, "frontdesk@smithtax.example"), public_email_kind: "unattributed" });
const gmail = strongDossier({ public_contact_email: ev({ address: "smithtaxoffice@gmail.com", owner_name: null }, "smithtaxoffice@gmail.com"), public_email_kind: "unattributed" });
const noEmail = strongDossier({ public_contact_email: NOT_FOUND, public_email_kind: NOT_FOUND });
const mismatch = strongDossier({ public_contact_email: ev({ address: "john.phillips@smithtax.example", owner_name: null }, "john.phillips@smithtax.example"), public_email_kind: "named_person" });

describe("never a named greeting unless the address is tied to that person", () => {
  const cases: [string, Dossier][] = [
    ["generic inbox", generic],
    ["unattributed inbox", unattributed],
    ["gmail inbox", gmail],
    ["no public email", noEmail],
    ["an address tied to someone else", mismatch],
  ];
  it.each(cases)("%s: every neutral style, never 'Jane'", (_label, d) => {
    for (const s of NEUTRAL_GREETING_STYLES) {
      const g = leadGreeting(d, { neutral_greeting_style: s }, false);
      expect(g).toBe(neutralGreeting(s, d));
      expect(g).not.toMatch(/Jane/);
    }
  });

  it("greets by first name only when the address is tied, and never after an override", () => {
    expect(leadGreeting(strongDossier(), offer, false)).toBe("Hi Jane,");
    expect(leadGreeting(strongDossier(), offer, true)).toBe("Hi there,");
  });

  it("the validator refuses a name on an untied address and accepts every neutral style", () => {
    const body = (greeting: string) => `${greeting}\nI noticed Smith Tax Services works with clients around Columbus. Is a written plan on file?`;
    const seq = (greeting: string): Sequence => ({ lead_id: "L1", tier: "C", persona: "p", angle: style.firm_type_angles.tax_preparer[0]!, emails: [email(1, body(greeting))] });
    for (const d of [generic, unattributed, noEmail, mismatch]) {
      expect(codes(seq("Hi Jane,"), d)).toContain("greeting_contact_mismatch");
      for (const s of NEUTRAL_GREETING_STYLES) expect(codes(seq(neutralGreeting(s, d)), d), s).not.toContain("greeting_contact_mismatch");
    }
    expect(codes(seq("Hi Jane,"), strongDossier())).not.toContain("greeting_contact_mismatch");
  });
});

describe("neutral_greeting_style (docs/01)", () => {
  it("defaults to 'Hi there,' and fills in the firm name", () => {
    expect(offer.neutral_greeting_style).toBe("Hi there,");
    expect(neutralGreeting("Hi there,", generic)).toBe("Hi there,");
    expect(neutralGreeting("Hi,", generic)).toBe("Hi,");
    expect(neutralGreeting("Hi {{firm_name}} team,", generic)).toBe("Hi Smith Tax Services team,");
    // Without a firm name, never a placeholder or a guess.
    expect(neutralGreeting("Hi {{firm_name}} team,", strongDossier({ firm_name: NOT_FOUND }))).toBe("Hi there,");
    expect(contactPlan(generic, "Hi,").greeting).toBe("Hi,");
  });
});

describe("with a neutral greeting, email 1 is never a generic template", () => {
  const seqOf = (e1: SequenceEmail): Sequence => ({ lead_id: "L1", tier: "C", persona: "p", angle: style.firm_type_angles.tax_preparer[0]!, emails: [e1] });

  it("needs the firm name or one verified detail outside the greeting line", () => {
    const bare = email(1, "Hi there,\nI help accounting firms keep client data safe. Is a written plan on file?");
    expect(codes(seqOf(bare), generic)).toContain("generic_email_1");
    // The firm's name in the greeting alone does not count.
    expect(codes(seqOf({ ...bare, body: bare.body.replace("Hi there,", "Hi Smith Tax Services team,") }), generic)).toContain("generic_email_1");
    expect(codes(seqOf(email(1, "Hi there,\nI help firms like Smith Tax Services keep client data safe. Is a written plan on file?")), generic)).not.toContain("generic_email_1");
    // A verified detail (detected by code) counts too.
    const detail = { ...email(1, "Hi there,\nI saw you offer payroll services. Is a written plan on file?"), grounding: ["services" as const] };
    expect(codes(seqOf(detail), generic)).not.toContain("generic_email_1");
    // The firm name in a subject line counts.
    expect(codes(seqOf({ ...bare, subject_a: "plan for Smith Tax Services" }), generic)).not.toContain("generic_email_1");
  });

  it("does not apply to a greeting by name (tied address) or to emails 2-5", () => {
    expect(codes(seqOf(email(1, "Hi Jane,\nI help accounting firms keep client data safe. Is a written plan on file?")), strongDossier())).not.toContain("generic_email_1");
    const e2: Sequence = { ...seqOf(email(1, "Hi there,\nSmith Tax Services question. Is a plan on file?")), emails: [email(2, "Hi there,\nFollowing up on my note. Does that help?")] };
    expect(codes(e2, generic)).not.toContain("generic_email_1");
  });
});

describe("no named contact: drafting, approval, and export proceed", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  const deps = (o: OfferConfig = offer): WriteDeps => ({
    db,
    llm: {} as WriteDeps["llm"],
    modelWrite: "unused",
    writerSystem: "",
    judgeSystem: "",
    style,
    offer: o,
    evidence: loadEvidence(),
    templates: loadTemplates(),
    facts: loadWriterFacts(),
    approved: loadApprovedSentences().sentences,
    personas: loadPersonaHeadings(),
  });
  const save = (id: string, d: Dossier) => db.insert(leads).values({ id, source: "web", status: "no_named_contact", dossierJson: JSON.stringify({ ...d, lead_id: id }) }).run();

  it("warning texts, in plain words", () => {
    expect(contactWarning(generic)).toBe("generic inbox: lower reply odds");
    expect(contactWarning(gmail)).toBe("address not tied to a named person: lower reply odds");
    expect(contactWarning(noEmail)).toBe("no public email; add before sending");
    expect(contactWarning(strongDossier())).toBeNull();
  });

  it("a lead with no email at all is drafted and approved, with the chosen neutral greeting", async () => {
    save("L-none", noEmail);
    const g = await generateSequence("L-none", noEmail, "C", deps({ ...offer, neutral_greeting_style: "Hi {{firm_name}} team," }));
    expect(g).toMatchObject({ status: "passed", contactWarning: "no public email; add before sending" });
    for (const e of g.sequence!.emails) expect(e.body.startsWith("Hi Smith Tax Services team,\n")).toBe(true);
    approveSequence(db, g.sequenceId!);
  });

  it("export: 'Ready to send' has rows with an address; 'Drafts' has every approved row with send_ready and contact_note", async () => {
    save("L-none", noEmail);
    save("L-generic", strongDossier({ ...generic, domain: "genericfirm.example" }));
    save("L-named", strongDossier({ domain: "namedfirm.example" }));
    for (const [id, d] of [["L-none", noEmail], ["L-generic", generic], ["L-named", strongDossier()]] as const) {
      const g = await generateSequence(id, d, "C", deps(ready));
      approveSequence(db, g.sequenceId!);
    }

    const r = buildExport(db, { offer: ready }, "ready");
    expect(r).toMatchObject({ blocked: [], mode: "ready", readyCount: 2, draftCount: 3 });
    expect(r.rows.map((x) => [x.lead_id, x.to_email, x.send_ready, x.contact_note])).toEqual([
      ["L-generic", "info@smithtax.example", "Y", "generic inbox: lower reply odds"],
      ["L-named", "jane@smithtax.example", "Y", ""],
    ]);
    expect(r.excluded).toEqual([{ lead_id: "L-none", firm_name: "Smith Tax Services", reason: "no public email; add before sending (included in the Drafts export)" }]);

    const drafts = buildExport(db, { offer: ready }, "drafts");
    expect(drafts.rows).toHaveLength(3);
    const none = drafts.rows.find((x) => x.lead_id === "L-none")!;
    // Never a guessed or constructed address.
    expect(none).toMatchObject({ to_email: "", send_ready: "N", contact_note: "no public email; add before sending" });
    const [header, ...lines] = drafts.csv.trim().split("\r\n");
    expect(header!.split(",").slice(0, 5)).toEqual(["lead_id", "firm_name", "to_email", "send_ready", "contact_note"]);
    expect(lines.find((l) => l.startsWith("L-none,"))).toMatch(/^L-none,Smith Tax Services,,N,no public email; add before sending,/);
    expect(drafts.csv).not.toMatch(/@smithtax\.example.*L-none|L-none.*@smithtax/);
  });

  it("the suppression list is still checked first in Drafts mode (by domain when there is no address)", async () => {
    save("L-none", noEmail);
    const g = await generateSequence("L-none", noEmail, "C", deps(ready));
    approveSequence(db, g.sequenceId!);
    addSuppression(db, noEmail.domain);
    const drafts = buildExport(db, { offer: ready }, "drafts");
    expect(drafts.rows).toEqual([]);
    expect(drafts.excluded[0]!.reason).toMatch(/^on the suppression list/);
  });
});

function email(n: number, body: string): SequenceEmail {
  return { n, send_day: style.send_days[n - 1]!, subject_a: n === 1 ? "security plan question" : null, subject_b: n === 1 ? "client data question" : null, body, grounding: [], template: true };
}

function codes(seq: Sequence, dossier: Dossier): string[] {
  return validateSequence(seq, { style, offer, dossier }).issues.map((i) => i.code);
}
