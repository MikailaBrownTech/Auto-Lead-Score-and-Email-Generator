import { isFound, type ApprovedSentence, type Dossier, type FirmType, type SequenceEmail, type StyleConfig } from "@clearpath/shared";
import { segmentType, type TemplateSet } from "../docs/templates";
import { leadFields } from "./merge";
import { approvedFor } from "./values";

export interface AssembleInput {
  dossier: Dossier;
  templates: TemplateSet;
  style: StyleConfig;
  approved: ApprovedSentence[];
  /** First name when the public address is tied to that person (contact rule); null otherwise. */
  firstName: string | null;
}

/** The segment (swap lines) for a lead: its primary firm type if docs/09 has a row for it, else cpa. */
export function leadSegment(d: Dossier, templates: TemplateSet): FirmType {
  return segmentType(isFound(d.firm_type) ? d.firm_type.value.primary : null, templates);
}

/**
 * Builds the five emails from the docs/09 fixed copy (no model call). No longer used to generate new
 * sequences (every tier is now written by the model); kept for edit.ts's legacy "original copy"
 * allowlist. Lead merge fields are filled here (firm, firm_short, city, first_name, approved_sentence);
 * settings merge fields stay as placeholders until the email is shown, checked, or exported. Greeting:
 * a first name tied to the address replaces email 1's role-based line; otherwise the role-based line
 * opens email 1. Emails 2-5 never greet.
 */
export function assembleEmails(input: AssembleInput): SequenceEmail[] {
  const { dossier: d, templates, style } = input;
  const segment = leadSegment(d, templates);
  const lead = leadFields(d);
  const approved = approvedFor(2, segment, input.approved);
  const fill = (text: string): string =>
    text
      .split("{{firm}}")
      .join(lead.firm ?? "your firm")
      .split("{{firm_short}}")
      .join(lead.firm_short ?? "your firm")
      .split("{{city}}")
      .join(lead.city ?? "your area")
      .split("{{first_name}}")
      .join(input.firstName ?? "")
      .split("{{approved_sentence}}")
      .join(approved?.text ?? "");

  return [1, 2, 3, 4, 5].map((n): SequenceEmail => {
    const t = templates.emails.get(n)!;
    let paras = [...t.paragraphs];
    if (n === 1 && input.firstName) paras = [`Hi ${input.firstName},`, ...(t.roleLine ? paras.slice(1) : paras)];
    // No VERIFIED sentence for this type: the paragraph is left out rather than filled with anything else.
    if (!approved) paras = paras.filter((p) => p.trim() !== "{{approved_sentence}}");
    let subject_a = t.subject_a;
    if (n === 3) subject_a = templates.segments[segment]?.email3Subject ?? subject_a;
    return {
      n,
      send_day: style.send_days[n - 1]!,
      subject_a: subject_a ? fill(subject_a) : null,
      subject_b: n === 1 && t.subject_b ? fill(t.subject_b) : null,
      body: paras.map(fill).join("\n\n").trim(),
      grounding: [],
      template: true,
    };
  });
}
