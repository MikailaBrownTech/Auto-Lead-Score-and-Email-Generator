import { FIRM_TYPES, NOT_FOUND, type OfferConfig, type Sequence, type SequenceEmail } from "@clearpath/shared";
import { describe, expect, it } from "vitest";
import { loadOffer, loadStyle } from "../src/docs/loader";
import { greetingFor, loadTemplates, templateEmail } from "../src/docs/templates";
import {
  bodySentences,
  containsPhrase,
  findAbsenceClaims,
  findLinks,
  renderEmail,
  validateSequence,
  type ValidationContext,
} from "../src/validators/email";
import { strongDossier } from "./fixtures/dossiers";

const style = loadStyle();
const realOffer = loadOffer();
const offer: OfferConfig = {
  ...realOffer,
  opt_out_line: "If this isn't relevant, reply 'no' and I won't email again.",
  physical_address: "123 Example St, Columbus, OH 43215",
};
const ctx: ValidationContext = { style, offer, dossier: strongDossier() };

function email(n: number, over: Partial<SequenceEmail> = {}): SequenceEmail {
  const bodies: Record<number, string> = {
    1: "Hi Jane,\nNoticed Smith Tax Services handles payroll for clients. Firms like that generally need a written information security plan under the FTC Safeguards Rule. Do you already have one in place?",
    2: "Hi Jane,\nThe Safeguards Rule expects a designated Qualified Individual and multi-factor authentication. Is that written down anywhere?",
    3: "Hi Jane,\nWould a 2-minute scorecard help? I can send it over.",
    4: "Hi Jane,\nHere is a short checklist. Book an assessment here: https://www.clearpathsecure.com/contact",
    5: "Hi Jane,\nI will stop here. Reply any time if it becomes useful.",
  };
  return {
    n,
    send_day: style.send_days[n - 1]!,
    subject_a: n === 1 ? "wisp for Smith Tax Services" : null,
    subject_b: n === 1 ? "written plan question" : null,
    body: bodies[n]!,
    grounding: n === 1 ? ["firm_name", "services"] : [],
    template: false,
    ...over,
  };
}

function sequence(over: Partial<Sequence> = {}, emails: SequenceEmail[] = [1, 2, 3, 4, 5].map((n) => email(n))): Sequence {
  return { lead_id: "L1", tier: "A", persona: "Solo or small tax preparer", angle: "irs_pub_4557_wisp", emails, ...over };
}

function withEmail(n: number, over: Partial<SequenceEmail>): Sequence {
  return sequence({}, [1, 2, 3, 4, 5].map((i) => (i === n ? email(i, over) : email(i))));
}

function codes(seq: Sequence, c: ValidationContext = ctx): string[] {
  return validateSequence(seq, c).issues.filter((i) => i.severity === "error").map((i) => i.code);
}

describe("validateSequence", () => {
  it("passes a clean sequence", () => {
    const r = validateSequence(sequence(), ctx);
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("enforces per-email word limits from docs/03 (sign-off and footer not counted)", () => {
    const long = "Hi Jane,\n" + "word ".repeat(80).trim() + "?";
    expect(codes(withEmail(1, { body: long }))).toContain("word_count");
    const exactly75 = "Hi Jane,\n" + "word ".repeat(73).trim() + "?";
    expect(codes(withEmail(1, { body: exactly75 }))).not.toContain("word_count");
  });

  it("limits the break-up email to 2-3 sentences (greeting excluded)", () => {
    expect(codes(withEmail(5, { body: "Hi Jane,\nOne sentence only." }))).toContain("sentence_count");
    expect(codes(withEmail(5, { body: "Hi Jane,\nOne. Two. Three. Four." }))).toContain("sentence_count");
    expect(codes(withEmail(5, { body: "Hi,\nOne. Two? Three." }))).not.toContain("sentence_count");
  });

  it.each([
    ["I hope this finds you well."],
    ["This is a real game-changer for firms."],
    ["Could we set up a quick call this week?"],
    ["I loved your post about tax season."],
    ["You could be fined for this."],
    ["I hope this finds you WELL."],
  ])("blocks banned phrase in: %s", (sentence) => {
    expect(codes(withEmail(2, { body: `Hi Jane,\n${sentence}` }))).toContain("banned_phrase");
  });

  it("matches banned phrases with curly apostrophes and ignores them inside other words", () => {
    expect(containsPhrase("Please don’t miss out on this.", "don't miss out")).toBe(true);
    expect(containsPhrase("resynergy", "synergy")).toBe(false);
  });

  it("blocks exclamation marks, emojis, and ALL CAPS (allowed acronyms excepted)", () => {
    expect(codes(withEmail(2, { body: "Hi Jane,\nThis matters!" }))).toContain("exclamation");
    expect(codes(withEmail(2, { body: "Hi Jane,\nThis matters \u{1F512}." }))).toContain("emoji");
    expect(codes(withEmail(2, { body: "Hi Jane,\nThis is VERY important." }))).toContain("all_caps");
    expect(codes(withEmail(2, { body: "Hi Jane,\nThe FTC and IRS both expect a WISP with MFA." }))).not.toContain(
      "all_caps",
    );
  });

  it("blocks leftover placeholders", () => {
    expect(codes(withEmail(2, { body: "Hi {{first_name}},\nText." }))).toContain("placeholder");
    expect(codes(withEmail(2, { body: "Hi Jane,\nWe serve [city] firms." }))).toContain("placeholder");
    expect(codes(withEmail(1, { subject_a: "wisp for {{firm_name}}" }))).toContain("placeholder");
  });

  it("allows at most one link, and only the CTA link from docs/01", () => {
    const two = "Hi Jane,\nSee https://www.clearpathsecure.com/contact and clearpathsecure.com/contact.";
    expect(codes(withEmail(4, { body: two }))).toContain("link_count");
    const other = "Hi Jane,\nRead https://example.com/guide for more.";
    expect(codes(withEmail(4, { body: other }))).toContain("link_not_allowed");
    const bare = "Hi Jane,\nBook at clearpathsecure.com/contact.";
    expect(codes(withEmail(4, { body: bare }))).not.toContain("link_not_allowed");
  });

  it("does not count an email address as a link", () => {
    expect(findLinks("Write to office@smithtax.example or jane@gmail.com.")).toEqual([]);
  });

  it("warns (does not block) on a link in email 1", () => {
    const r = validateSequence(
      withEmail(1, { body: "Hi Jane,\nQuestion about your plan. Is it written? https://www.clearpathsecure.com/contact" }),
      ctx,
    );
    expect(r.issues.find((i) => i.code === "link_in_email_1")?.severity).toBe("warning");
  });

  it("blocks proof claims while approved_proof is empty", () => {
    for (const s of ["Our clients include three CPA firms.", "We've helped firms like yours pass audits.", "I am certified in this."]) {
      expect(codes(withEmail(2, { body: `Hi Jane,\n${s}` }))).toContain("unapproved_proof");
    }
  });

  it("allows a proof claim only when the sentence contains an approved_proof item", () => {
    const approved = { ...ctx, offer: { ...offer, approved_proof: ["CompTIA Security+ certified"] } };
    expect(codes(withEmail(2, { body: "Hi Jane,\nI am CompTIA Security+ certified." }), approved)).not.toContain(
      "unapproved_proof",
    );
    expect(codes(withEmail(2, { body: "Hi Jane,\nOur clients love us." }), approved)).toContain("unapproved_proof");
  });

  it("checks subjects: lowercase except the firm name, word limit, no fake Re:", () => {
    expect(codes(withEmail(1, { subject_a: "Wisp for you" }))).toContain("subject_case");
    expect(codes(withEmail(1, { subject_a: "wisp for Smith Tax Services" }))).not.toContain("subject_case");
    expect(codes(withEmail(1, { subject_a: "a very long subject line here" }))).toContain("subject_length");
    expect(codes(withEmail(1, { subject_a: "re: your plan" }))).toContain("fake_reply");
  });

  it("allows at most one personal detail per email (firm name and greeting don't count)", () => {
    expect(codes(withEmail(1, { grounding: ["firm_name", "services", "location"] }))).toContain("too_many_details");
    expect(codes(withEmail(1, { grounding: ["firm_name", "decision_maker", "services"] }))).not.toContain(
      "too_many_details",
    );
  });

  it("blocks grounding on a NOT_FOUND field", () => {
    const d = strongDossier({ software_mentioned: NOT_FOUND });
    expect(codes(withEmail(2, { grounding: ["software_mentioned"] }), { ...ctx, dossier: d })).toContain(
      "grounding_not_found",
    );
  });

  it.each([
    ["We guarantee compliance with the rule."],
    ["Our service offers guaranteed compliance."],
    ["We'll make you compliant in a week."],
    ["Your data will be 100% secure."],
    ["This protects you from fines."],
    ["Our process is FTC-approved."],
    ["This is your final notice."],
    ["Act now before the deadline."],
  ])("blocks claim-safety phrase in: %s", (sentence) => {
    const c = codes(withEmail(2, { body: `Hi Jane,
${sentence}` }));
    expect(c.some((x) => x === "banned_phrase" || x === "unapproved_proof")).toBe(true);
  });

  it.each([
    ["You don't have a WISP yet."],
    ["Smith Tax Services does not have a written information security plan."],
    ["Your site shows no security policy."],
    ["You are operating without a written plan."],
    ["The firm lacks an incident response plan."],
  ])("blocks a claim that the firm lacks a plan: %s", (sentence) => {
    expect(codes(withEmail(2, { body: `Hi Jane,
${sentence}` }))).toContain("absence_claim");
  });

  it.each([
    ["Do you have a written plan in place?"],
    ["If you don't have a WISP yet, I can send a checklist."],
    ["The rule requires a written information security program."],
    ["I have not heard back, so I will stop here."],
  ])("allows questions, conditionals, and neutral statements: %s", (sentence) => {
    expect(codes(withEmail(2, { body: `Hi Jane,
${sentence}` }))).not.toContain("absence_claim");
  });

  it("checks subjects for absence claims too", () => {
    expect(findAbsenceClaims("no wisp at smith tax", style)).toHaveLength(1);
    expect(codes(withEmail(1, { subject_b: "no wisp on file" }))).toContain("absence_claim");
  });

  it.each([
    ["Violations can cost $50,000 each."],
    ["Fines reach 50,000 dollars."],
    ["Our plan is $99 a month."],
  ])("blocks dollar amounts: %s", (sentence) => {
    expect(codes(withEmail(2, { body: `Hi Jane,
${sentence}` }))).toContain("dollar_amount");
  });

  it("blocks penalty language even without an amount", () => {
    expect(codes(withEmail(2, { body: "Hi Jane,\nThe rule carries a civil penalty for each violation." }))).toContain(
      "penalty_language",
    );
  });

  it("greets the decision maker by name only when the public address is theirs", () => {
    // strongDossier: decision maker Jane Smith, address jane@smithtax.example -> "Hi Jane," is right.
    expect(codes(sequence())).not.toContain("greeting_contact_mismatch");
    const mismatch = strongDossier({
      public_contact_email: { value: { address: "john.phillips@smithtax.example", owner_name: null }, evidence_url: "https://smithtax.example/", evidence_quote: "john.phillips@smithtax.example" },
    });
    const c = { ...ctx, dossier: mismatch };
    const errs = validateSequence(sequence(), c).issues.filter((i) => i.code === "greeting_contact_mismatch");
    expect(errs).toHaveLength(5);
    expect(errs[0]!.message).toMatch(/john\.phillips@smithtax\.example is not tied to Jane Smith; use "Hi,"/);
    const neutral = sequence({}, [1, 2, 3, 4, 5].map((n) => email(n, { body: email(n).body.replace("Hi Jane,", "Hi,") })));
    expect(codes(neutral, c)).not.toContain("greeting_contact_mismatch");
    // Wrong name entirely.
    expect(codes(withEmail(2, { body: "Hi Bob,\nThe Safeguards Rule expects a Qualified Individual. Is that written down?" }))).toContain(
      "greeting_contact_mismatch",
    );
  });

  it("blocks any DKIM claim", () => {
    expect(codes(withEmail(2, { body: "Hi Jane,\nYour DKIM looks fine." }))).toContain("dkim_claim");
  });

  it("checks send days and the angle list", () => {
    expect(codes(withEmail(3, { send_day: 8 }))).toContain("send_day");
    expect(codes(sequence({ angle: "made_up_angle" }))).toContain("angle");
    expect(codes(sequence({ angle: "busy_season" }))).toContain("angle"); // CPA angle, but this lead is a tax preparer
  });

  it("enforces tier gating: C is all templates, B uses templates for 3-5", () => {
    expect(codes(sequence({ tier: "C" })).filter((c) => c === "tier_gating")).toHaveLength(5);
    expect(codes(sequence({ tier: "B" })).filter((c) => c === "tier_gating")).toHaveLength(3);
    expect(codes(sequence({ tier: "A" }))).not.toContain("tier_gating");
  });

  it("warns that export is blocked while the opt-out line or address is empty", () => {
    const r = validateSequence(sequence(), { ...ctx, offer: realOffer });
    expect(r.issues.find((i) => i.code === "footer_incomplete")?.severity).toBe("warning");
  });

  it("renders the footer from docs/01", () => {
    const text = renderEmail("Hi Jane,\nBody.", offer);
    expect(text).toBe(`Hi Jane,\nBody.\n\nMikaila Brown\n${offer.opt_out_line}\n${offer.physical_address}`);
  });

  it("splits sentences without counting the greeting", () => {
    expect(bodySentences("Hi Jane,\nOne. Two? Three.")).toEqual(["One.", "Two?", "Three."]);
  });
});

describe("docs/09 templates pass the same validators", () => {
  const templates = loadTemplates();

  const cases = FIRM_TYPES.flatMap((firmType) => [
    { firmType, greeting: greetingFor("Jane Smith"), firmRef: "Smith Tax Services" },
    { firmType, greeting: greetingFor(null), firmRef: "your firm" },
  ]);

  const withCta = cases.flatMap((c) => [
    { ...c, ctaType: "checklist" as const },
    { ...c, ctaType: "scorecard" as const },
  ]);

  it.each(withCta)("tier C sequence for $firmType, $ctaType ($greeting / $firmRef)", ({ firmType, greeting, firmRef, ctaType }) => {
    const vars = { greeting, firm_ref: firmRef, cta_url: offer.cta_url };
    const emails = [1, 2, 3, 4, 5].map((n) => templateEmail(templates, n, firmType, vars, style, ctaType));
    const seq: Sequence = {
      lead_id: "LT",
      tier: "C",
      persona: "template",
      angle: style.firm_type_angles[firmType][0]!,
      emails,
    };
    const dossier = strongDossier({
      firm_type: { value: { primary: firmType, secondary: [] }, evidence_url: "https://smithtax.example/", evidence_quote: "x" },
    });
    const r = validateSequence(seq, { style, offer, dossier });
    expect(r.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(r.issues.filter((i) => i.severity === "warning")).toEqual([]);
  });

  it("templates contain no dollar amounts or penalty language", () => {
    for (const [name, t] of templates) {
      const all = [t.subject_a ?? "", t.subject_b ?? "", t.body].join(" ");
      expect(all, name).not.toMatch(/\$\s?\d|dollars|penalt|per violation/i);
    }
  });

  it("email 3 follows cta_type: the default checklist offer never mentions the scorecard", () => {
    expect(realOffer.cta_type).toBe("checklist");
    const vars = { greeting: "Hi,", firm_ref: "your firm", cta_url: offer.cta_url };
    const checklist = templateEmail(templates, 3, "cpa", vars, style, "checklist").body;
    expect(checklist).toMatch(/one-page checklist/);
    expect(checklist).not.toMatch(/scorecard/i);
    expect(templateEmail(templates, 3, "cpa", vars, style, "scorecard").body).toMatch(/scorecard/);
  });

  it("uses the greeting fallback 'Hi,' when no name is known", () => {
    expect(greetingFor(null)).toBe("Hi,");
    expect(greetingFor("  Jane   Smith ")).toBe("Hi Jane,");
  });
});
