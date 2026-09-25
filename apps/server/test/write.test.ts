import { FIRM_TYPES, type Dossier, type FirmType, type OfferConfig, type Sequence, type SequenceEmail } from "@clearpath/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { leads, runs, sequences } from "../src/db/schema";
import { parseTemplates } from "../src/docs/templates";
import { bodySentences, validateSequence } from "../src/validators/email";
import { assembleEmails } from "../src/write/assemble";
import { checkEdits, rewriteOne, runJudge, saveEdits } from "../src/write/edit";
import { approveSequence, exportBlockers, generateSequence } from "../src/write/generate";
import { firmShort, renderSettings, renderSignature } from "../src/write/merge";
import { examplesFor, loadExampleSequences, writerMessage } from "../src/write/prompt";
import { buildEmail, writerInput } from "../src/write/writer";
import { ev, strongDossier } from "./fixtures/dossiers";
import { userText } from "./fixtures/fakeapi";
import { approved, evidence, offer, personas, READY_OFFER, scripted, style, templates, testWriteDeps, writerAnswerFor } from "./fixtures/write-deps";

let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
});

// strongDossier: Smith Tax Services (tax_preparer), Columbus OH, services "Individual tax returns" and
// "Payroll services", decision maker Jane Smith with jane@ (tied to her), software Drake, a team of six.
const generic = (over: Partial<Dossier> = {}) =>
  strongDossier({ public_contact_email: ev({ address: "info@smithtax.example", owner_name: null }, "info@smithtax.example"), public_email_kind: "generic_inbox", ...over });
const ofType = (primary: FirmType, d: Dossier = generic()): Dossier => ({
  ...d,
  firm_type: ev({ primary, secondary: [] }, "firm type quote"),
  target_industry_fit: { value: true, reason: "test", qualifying_type: primary },
});
const saveLead = (id: string, d: Dossier) => db.insert(leads).values({ id, source: "web", status: "extracted", dossierJson: JSON.stringify(d) }).run();
const IRS = approved.find((a) => a.id === "irs_pub_4557_wisp")!.text;
const inputFor = (d: Dossier, first: string | null = null) => writerInput(d, { offer, evidence, style, approved, personas }, first);
/** A sequence of writer-written emails built from the fake writer's answer for this lead. */
function written(d: Dossier, first: string | null = null, edit?: (bodies: string[]) => string[]): Sequence {
  const input = inputFor(d, first);
  const answer = writerAnswerFor(writerMessage(input));
  const bodies = edit ? edit(answer.emails.map((e) => e.body)) : answer.emails.map((e) => e.body);
  const emails = answer.emails.map((e, i) => buildEmail({ ...e, body: bodies[i]! }, input, style.send_days[i]!, true).email);
  return { lead_id: "L1", tier: "B", persona: input.persona, angle: input.angle, emails };
}
const errorsOf = (s: Sequence, d: Dossier, o: OfferConfig = READY_OFFER) => validateSequence(s, { style, offer: o, dossier: d, approvedSentences: approved.map((a) => a.text) }).issues.filter((i) => i.severity === "error");
const codesOf = (s: Sequence, d: Dossier) => errorsOf(s, d).map((i) => i.code);
const withBody = (n: number, text: string) => (b: string[]) => b.map((x, i) => (i === n - 1 ? text : x));

describe("docs/03 example sequences (few-shot)", () => {
  it("three founder examples, none with \"Hi there,\"; the tuning note is not an example", () => {
    const ex = loadExampleSequences();
    expect(ex.examples.map((e) => e.id)).toEqual(["A", "B", "C"]);
    for (const e of ex.examples) expect(e.text).not.toMatch(/hi there/i);
    expect(ex.examples.map((e) => e.text).join()).not.toMatch(/What to feed the writer prompt/);
    expect(ex.preamble).toMatch(/style examples, not templates to copy verbatim/);
  });

  it("two examples per lead, rotated by lead id, the same every time for a lead", () => {
    const ex = loadExampleSequences();
    const pairs = new Set(["lead-a", "lead-b", "lead-c", "lead-d", "lead-e", "lead-f", "lead-g", "lead-h"].map((id) => examplesFor(id, ex).join(",")));
    expect(pairs.size).toBeGreaterThan(1);
    for (const id of ["lead-a", "x"]) {
      const pair = examplesFor(id, ex);
      expect(new Set(pair).size).toBe(2);
      expect(examplesFor(id, ex)).toEqual(pair);
    }
  });

  it("the system prompt holds the style guide and two examples, and nothing about any lead", () => {
    const { deps } = testWriteDeps(db);
    const system = deps.writerSystem("lead-a");
    const ids = examplesFor("lead-a", loadExampleSequences());
    for (const id of ["A", "B", "C"]) expect(system.includes(`## EXAMPLE ${id}:`)).toBe(ids.includes(id));
    expect(system).toMatch(/REGULATORY RULE/);
    expect(system).not.toMatch(/Smith Tax|evidence_quote/);
  });
});

describe("writer input: verified values only", () => {
  it("firm type, persona, angle, greeting rule, settings, and the approved sentence; never quotes, people, or addresses", () => {
    const msg = writerMessage(inputFor(generic()));
    expect(msg).toMatch(/"firm_name": "Smith Tax Services"/);
    expect(msg).toMatch(/persona: Solo or small tax preparer/);
    expect(msg).toMatch(/greeting rule: no named contact.*never "Hi there,"/);
    expect(msg).toContain(IRS);
    expect(msg).toMatch(/booking link \(email 4\): write \{\{booking_link\}\}/);
    expect(msg).not.toMatch(/evidence_quote|evidence_url|Jane|info@|jane@|614/);
    expect(writerMessage(inputFor(strongDossier(), "Jane"))).toMatch(/Email 1 starts "Hi Jane,"/);
  });

  it("the approved sentence follows the firm type (docs/02)", () => {
    expect(inputFor(ofType("cpa")).approvedSentence).toBe(approved.find((a) => a.id === "insurers_ask_at_renewal")!.text);
    expect(inputFor(ofType("tax_preparer")).approvedSentence).toBe(IRS);
    expect(inputFor(ofType("bookkeeper")).approvedSentence).toBe(approved.find((a) => a.id === "rule_requirements")!.text);
  });
});

describe("the approved sentence is spliced in by code at [[APPROVED]]", () => {
  const input = inputFor(generic());
  const e2 = (body: string, repair = false) => buildEmail({ n: 2, subject_a: null, subject_b: null, body }, input, 3, repair);

  it("at the marker, verbatim, as its own paragraph (inline markers too)", () => {
    expect(e2("Here is the short list.\n\n[[APPROVED]]\n\nCurious where you are.").email.body).toBe(`Here is the short list.\n\n${IRS}\n\nCurious where you are.`);
    const inline = e2("What's usually expected is fairly specific: [[APPROVED]] Curious where you are.").email.body;
    expect(bodySentences(inline)).toContain(IRS);
  });

  it("a missing marker is a problem for the rewrite, and repaired by code after it", () => {
    expect(e2("No marker here.\n\nCurious where you are.").problems.join()).toMatch(/marker is missing/);
    expect(e2("No marker here.\n\nCurious where you are.", true).email.body).toBe(`No marker here.\n\n${IRS}\n\nCurious where you are.`);
  });

  it("a marker outside email 2 is removed; a tied contact's greeting is added if the model left it out", () => {
    const e3 = buildEmail({ n: 3, subject_a: null, subject_b: null, body: "Checklist?\n\n[[APPROVED]]" }, input, 7, true);
    expect(e3.problems.join()).toMatch(/only in email 2/);
    expect(e3.email.body).not.toMatch(/APPROVED/);
    const named = buildEmail({ n: 1, subject_a: "a", subject_b: "b", body: "Quick question about client data." }, inputFor(strongDossier(), "Jane"), 0, true);
    expect(named.email.body.startsWith("Hi Jane,\n\n")).toBe(true);
  });
});

describe("validators (lighter, still enforced)", () => {
  it("the fake writer's sequence passes for every firm type, named or not", () => {
    for (const t of FIRM_TYPES) {
      expect(codesOf(written(ofType(t)), ofType(t)), t).toEqual([]);
      expect(codesOf(written(ofType(t, strongDossier()), "Jane"), ofType(t, strongDossier())), `${t} named`).toEqual([]);
    }
  });

  it("word limits: 130 / 150 / 110 / 140 / 60", () => {
    expect(style.word_limits).toEqual({ "1": 130, "2": 150, "3": 110, "4": 140, "5": 60 });
    const d = generic();
    expect(codesOf(written(d, null, withBody(5, `${"word ".repeat(61).trim()}.`)), d)).toContain("word_count");
    // 130 words plus the spliced approved sentence stays under 150.
    expect(codesOf(written(d, null, withBody(2, `${"word ".repeat(130).trim()}.`)), d)).not.toContain("word_count");
  });

  it("two questions and two details in one email are fine (guidance, not rules)", () => {
    const d = generic();
    const s = written(d, null, withBody(1, "Quick question for whoever handles client data at Smith Tax Services: with individual tax returns and payroll services, is there a written plan yet? If not you, who should I ask?"));
    expect(codesOf(s, d)).toEqual([]);
  });

  it("any sentence stating what a law or rule requires, other than the approved one, fails", () => {
    const d = generic();
    for (const bad of [
      "The FTC Safeguards Rule requires every tax preparer to have a written plan.",
      "Tax preparers must keep a written information security program.",
      "Compliance is mandatory for firms like yours.",
      "It tends to come up around EFIN renewal time.",
    ]) {
      expect(codesOf(written(d, null, withBody(3, `Quick note. ${bad} Want the checklist?`)), d), bad).toContain("unapproved_regulatory_sentence");
    }
  });

  it("referring to the requirement, asking about a rule, a verified service name, and 'fine' are not claims", () => {
    const d = generic({ services: { value: ["IRS Representation"], evidence: [{ item: "IRS Representation", evidence_url: "https://smithtax.example/" }] } });
    const s = written(d, null, (b) => [
      b[0]!,
      b[1]!.replace("Curious where things stand.", "That requirement is the part most firms have not written down yet. Curious where things stand."),
      "Does the FTC rule come up with your clients? I put together a one-page checklist.",
      b[3]!,
      "I'll leave it here, which is completely fine. With the IRS Representation work, a written plan may come up later.",
    ]);
    expect(codesOf(s, d)).toEqual([]);
  });

  it("no evaluation of the prospect; no unapproved proof or traction; no penalty amounts; no \"Hi there,\"", () => {
    const d = generic();
    expect(codesOf(written(d, null, withBody(3, "Your firm clearly has an impressive setup. Want the checklist?")), d)).toContain("evaluates_prospect");
    expect(codesOf(written(d, null, withBody(3, "Hope you have a great season. Want the checklist?")), d)).not.toContain("evaluates_prospect");
    expect(codesOf(written(d, null, withBody(3, "I work with a dozen Ohio firms on this. Want the checklist?")), d)).toContain("unapproved_proof");
    expect(codesOf(written(d, null, withBody(3, "Firms can face $50,000 in penalties. Want the checklist?")), d)).toEqual(expect.arrayContaining(["dollar_amount", "penalty_language"]));
    expect(codesOf(written(d, null, withBody(1, "Hi there,\n\nQuick question about Smith Tax Services: is there a written plan?")), d)).toContain("banned_phrase");
  });

  it("never a name unless the address is tied to that person", () => {
    const d = generic();
    expect(codesOf(written(d, null, withBody(1, "Hi Jane,\n\nQuick question about Smith Tax Services: is there a written plan?")), d)).toContain("greeting_contact_mismatch");
  });

  it("the footer is required for export; empty settings block export, not the text", () => {
    const d = generic();
    const s = written(d);
    const empty: OfferConfig = { ...offer, founding_client_offer: null, booking_link: "", region: "", opt_out_line: "" };
    expect(errorsOf(s, d, empty)).toEqual([]);
    expect(exportBlockers(empty, s).join("\n")).toMatch(/founding_client_offer \(offer\), booking_link, region/);
    expect(exportBlockers(empty, s).join("\n")).toMatch(/opt_out_line/);
    expect(exportBlockers(READY_OFFER, s)).toEqual([]);
  });
});

describe("generateSequence", () => {
  it("tier B: one writer call (all five emails) and one judge call; passed; approved sentence in email 2", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db);
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g).toMatchObject({ status: "passed", firstPassValid: true, writerCalls: 1, judgeCalls: 1 });
    expect(g.sequence!.emails.every((e) => !e.template)).toBe(true);
    expect(g.sequence!.emails[1]!.body).toContain(IRS);
    expect(db.select().from(runs).all().map((r) => r.callType)).toEqual(["write", "judge"]);
    const p = create.mock.calls[0]![0];
    expect(p.model).toBe("test-haiku");
    expect(JSON.stringify(p.messages)).not.toMatch(/evidence_quote|evidence_url/);
  });

  it("tier C: the docs/09 fixed copy, no model call", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(db);
    const g = await generateSequence("L1", generic(), "C", deps);
    expect(create).not.toHaveBeenCalled();
    expect(g.status).toBe("passed");
    expect(g.sequence!.emails.every((e) => e.template)).toBe(true);
    expect(g.sequence!.emails[0]!.body).toMatch(/^Quick question for whoever looks after IT and client data at Smith Tax Services:/);
  });

  it("validator errors: one rewrite that gets its own draft plus the specific errors", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(
      db,
      scripted((m, k) => {
        const a = writerAnswerFor(m);
        if (k === 0) a.emails[2]!.body = "Your firm clearly has an impressive setup. Want the checklist?";
        return a;
      }),
    );
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g).toMatchObject({ status: "passed", firstPassValid: false, writerCalls: 2 });
    const rewrite = userText(create.mock.calls[1]![0]);
    expect(rewrite).toMatch(/<your_draft/);
    expect(rewrite).toContain("impressive setup");
    expect(rewrite).toMatch(/evaluates the prospect/);
    expect(rewrite).toMatch(/rework the sentences in your own voice/);
  });

  it("judge claims also get the one rewrite, and the judge runs again", async () => {
    saveLead("L1", generic());
    const claim = { unsupported_claims: [{ email: 1, claim: "tends to come up at renewal", reason: "not_in_verified_regulatory_facts" }] };
    const { deps } = testWriteDeps(
      db,
      scripted(
        (m, k) => {
          const a = writerAnswerFor(m);
          if (k === 1) a.emails[0]!.body = a.emails[0]!.body.replace("has anyone asked you", "has anyone, a bank or a client, asked you");
          return a;
        },
        [claim, { unsupported_claims: [] }],
      ),
    );
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g).toMatchObject({ status: "passed", writerCalls: 2, judgeCalls: 2 });
  });

  it("still failing after the one rewrite: blocked, shown with both drafts' errors (never more calls)", async () => {
    saveLead("L1", generic());
    const bad = (m: string) => {
      const a = writerAnswerFor(m);
      a.emails[2]!.body = "The FTC Safeguards Rule requires a written plan. Want the checklist?";
      return a;
    };
    const { deps, create } = testWriteDeps(db, scripted(bad));
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g.status).toBe("blocked");
    expect(g.drafts.map((d) => d.errors.map((e) => e.code))).toEqual([["unapproved_regulatory_sentence"], ["unapproved_regulatory_sentence"]]);
    expect(create.mock.calls.filter((c) => (c[0].tools![0] as { name: string }).name === "write_sequence")).toHaveLength(2);
  });

  it("two unusable answers: no sequence, with the reason", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db, scripted([{ oops: true }]));
    const g = await generateSequence("L1", generic(), "B", deps);
    expect(g.status).toBe("no_sequence");
    expect(g.reason).toMatch(/could not be used/);
  });

  it("a gated lead gets no sequence until approved", async () => {
    const d = generic({ gate: { status: "out_of_icp", reasons: ["staff count 85 is above 60"] } });
    const { deps } = testWriteDeps(db);
    expect((await generateSequence("L1", d, "B", deps)).status).toBe("no_sequence");
  });
});

describe("approval, edits, judge, rewrite one email", () => {
  it("approval needs the newest sequence with validators and judge passed", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db);
    const older = await generateSequence("L1", generic(), "B", deps);
    const newer = await generateSequence("L1", generic(), "B", deps);
    expect(() => approveSequence(db, older.sequenceId!)).toThrow(/newest/);
    approveSequence(db, newer.sequenceId!);
    expect(db.select().from(sequences).where(eq(sequences.id, newer.sequenceId!)).get()!.status).toBe("approved");
  });

  it("a hand edit clears the judge result; running the judge again allows approval", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db);
    const g = await generateSequence("L1", generic(), "B", deps);
    const e3 = g.sequence!.emails[2]!;
    const edited = saveEdits(db, g.sequenceId!, [{ n: 3, body: e3.body.replace("one-page", "short one-page") }], deps);
    expect(edited).toMatchObject({ judgeRequired: true, status: "blocked", judge: null });
    expect((await runJudge(db, g.sequenceId!, deps)).status).toBe("passed");
    approveSequence(db, g.sequenceId!);
  });

  it("a hand-edited regulatory claim is caught live", async () => {
    saveLead("L1", generic());
    const { deps } = testWriteDeps(db);
    const g = await generateSequence("L1", generic(), "B", deps);
    const r = checkEdits(db, g.sequenceId!, [{ n: 3, body: "The FTC requires a written plan by next year. Want the checklist?" }], deps);
    expect(r.validation.issues.map((i) => i.code)).toContain("unapproved_regulatory_sentence");
  });

  it("rewrite one email: one writer call that sees the whole draft; only that email changes", async () => {
    saveLead("L1", generic());
    const { deps, create } = testWriteDeps(
      db,
      scripted((m, k) => {
        const a = writerAnswerFor(m);
        if (k === 1) a.emails[2]!.body = "A fresh take: I made a one-page checklist you can go through in ten minutes. Want it?";
        return a;
      }),
    );
    const g = await generateSequence("L1", generic(), "B", deps);
    const r = await rewriteOne(db, g.sequenceId!, 3, deps);
    expect(r.sequence.emails[2]!.body).toMatch(/^A fresh take/);
    expect(r.sequence.emails[0]).toEqual(g.sequence!.emails[0]);
    expect(userText(create.mock.calls.at(-1)![0])).toMatch(/Rewrite email 3/);
    const { deps: c } = testWriteDeps(db);
    saveLead("L2", generic());
    const t = await generateSequence("L2", generic(), "C", c);
    await expect(rewriteOne(db, t.sequenceId!, 1, c)).rejects.toThrow(/Tier C/);
  });
});

describe("docs/09: the tier C fixed copy", () => {
  it("five emails, the role-based line, segment swaps, and the signature block; no personal-line slot", () => {
    expect([...templates.emails.keys()]).toEqual([1, 2, 3, 4, 5]);
    expect(templates.emails.get(1)!.roleLine).toBe("Quick question for whoever looks after IT and client data at {{firm}}:");
    expect([...templates.emails.values()].flatMap((t) => t.paragraphs).join()).not.toMatch(/personal_line/);
    expect(templates.segments.bookkeeper?.email3Subject).toBe("one-page checklist for bookkeeping firms");
    expect(templates.signature[0]).toBe("{{sender_name}}");
  });

  it("refuses an unknown merge field or an email without {{signature}}", () => {
    const md = (e1: string) => [`## Email 1\nSubject A: a\nSubject B: b\n\n${e1}`, ...[2, 3, 4, 5].map((n) => `## Email ${n}\nText.\n\n{{signature}}`), `## Signature block\n{{sender_name}}`].join("\n\n");
    expect(() => parseTemplates(md("Opening for {{firm}}:\n\nQuestion?\n\n{{signature}}"))).not.toThrow();
    expect(() => parseTemplates(md("Opening {{favorite_color}}:\n\nQuestion?\n\n{{signature}}"))).toThrow(/unknown merge field/);
    expect(() => parseTemplates(md("Opening:\n\nQuestion?"))).toThrow(/must end with a \{\{signature\}\} line/);
  });

  it("assembled for every segment, named or not, it passes the validators", () => {
    for (const t of FIRM_TYPES) {
      for (const [d, first] of [
        [ofType(t), null],
        [ofType(t, strongDossier()), "Jane"],
      ] as const) {
        const emails: SequenceEmail[] = assembleEmails({ dossier: d, templates, style, approved, firstName: first });
        const s: Sequence = { lead_id: "L1", tier: "C", persona: "p", angle: style.firm_type_angles[t][0]!, emails };
        expect(errorsOf(s, d), `${t} ${first ?? "role line"}`).toEqual([]);
      }
    }
  });

  it("merge fields: firm_short, settings filled when shown, the signature block", () => {
    expect(firmShort("Smith & Jones, LLC")).toBe("Smith & Jones");
    expect(renderSettings("{{offer}} at {{booking_link}}", READY_OFFER)).toBe("half off the first three months at https://cal.example.com/clearpath/15min");
    expect(renderSignature(templates.signature, READY_OFFER).slice(0, 2)).toEqual(["Mikaila Brown", `${READY_OFFER.sender_title}, ${READY_OFFER.company_name}`]);
  });
});
