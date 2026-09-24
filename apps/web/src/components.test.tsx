// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExportView, SequenceView } from "@clearpath/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_REASON, ReasonForm } from "./components/ReasonForm";
import { ExportPanel } from "./pages/Export";
import { approvalState, SequenceEditor } from "./pages/Sequence";

const APPROVED = "The FTC Safeguards Rule applies to non-bank financial institutions.";
const LINE = "Smith Tax handles Tax Preparation, which means holding a lot of sensitive client financial data.";

function view(over: Partial<SequenceView> = {}): SequenceView {
  const email = (n: number, template: boolean) => ({
    n,
    send_day: [0, 3, 7, 12, 18][n - 1]!,
    subject_a: n === 1 ? "security plan question" : null,
    subject_b: n === 1 ? "client data question" : null,
    body: n === 1 ? `Quick question for whoever looks after IT at Smith Tax:\n\n${LINE}\n\n${APPROVED} Is a written plan on file?` : `Email ${n}. Does that help?`,
    grounding: [],
    template,
    ...(n === 1 ? { personal_line: { text: LINE, source: "model" as const } } : {}),
  });
  const emails = [email(1, true), email(2, true), email(3, true), email(4, true), email(5, true)];
  return {
    id: 7,
    leadId: "lead-smith",
    firm: "Smith Tax",
    tier: "B",
    status: "blocked",
    sequence: { lead_id: "lead-smith", tier: "B", persona: "p", angle: "irs_pub_4557_wisp", emails },
    issues: [],
    validationPass: true,
    judgeRequired: true,
    judge: null,
    contactWarning: null,
    exportBlockers: [],
    approvedSentences: [{ id: "applies_non_bank", text: APPROVED }],
    rewritable: [1],
    wordLimits: { "1": 130, "2": 140, "3": 100, "4": 130, "5": 75 },
    subjectMaxWords: 6,
    signature: ["Mikaila Brown", "Founder, ClearPath IT"],
    rendered: emails.map((e) => ({ n: e.n, subject_a: e.subject_a, subject_b: e.subject_b, body: e.body })),
    kind: "custom",
    personalLine: { text: LINE, source: "model", note: null },
    ...over,
  };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const body = handler(url, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sequence editor: code validators re-run live as you type", () => {
  it("sends the edited text to the live check and shows the new issues", async () => {
    const fetchFn = mockFetch(() =>
      view({ validationPass: false, issues: [{ severity: "error", email: 1, code: "exclamation", message: "body contains an exclamation mark" }] }),
    );
    render(<SequenceEditor initial={view()} />);
    expect(screen.getByText("Validators pass")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Email 1 body"), { target: { value: "Hi,\nGreat news!" } });
    await waitFor(() => expect(screen.getByText("body contains an exclamation mark")).toBeTruthy());
    expect(screen.getByText("1 validator error")).toBeTruthy();
    const [url, init] = fetchFn.mock.calls.at(-1)!;
    expect(url).toBe("/api/sequences/7/check");
    expect(JSON.parse(String(init!.body)).emails[0].body).toBe("Hi,\nGreat news!");
  });

  it("marks code-inserted approved sentences apart from other text, with a live word count", () => {
    render(<SequenceEditor initial={view()} />);
    const marks = document.querySelectorAll("mark.approved");
    expect([...marks].some((m) => m.textContent === APPROVED)).toBe(true);
    expect(screen.getAllByText(/words \(limit 75\)/).length).toBe(1);
  });
});

describe("approve gating", () => {
  it("Approve stays disabled until validators and the judge both pass on saved text", async () => {
    expect(approvalState(view(), false)).toEqual({ enabled: false, reasons: ["Run the judge on the current text."] });
    expect(approvalState(view({ validationPass: false }), false).reasons).toContain("Fix the validator errors.");
    const claim = { unsupported_claims: [{ email: 1, claim: "x", reason: "other" as const }] };
    expect(approvalState(view({ judge: claim }), false).reasons).toContain("The judge listed unsupported claims.");
    expect(approvalState(view({ judge: { unsupported_claims: [] } }), true).reasons).toEqual(["Save your changes first."]);
    // A missing named contact is a warning only: it never disables Approve.
    expect(approvalState(view({ judge: { unsupported_claims: [] }, contactWarning: "no public email; add before sending" }), false)).toEqual({ enabled: true, reasons: [] });
    expect(approvalState(view({ judge: { unsupported_claims: [] } }), false)).toEqual({ enabled: true, reasons: [] });
    expect(approvalState(view({ judgeRequired: false }), false).enabled).toBe(true);

    render(<SequenceEditor initial={view()} />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mockFetch(() => view({ judge: { unsupported_claims: [] } }));
    render(<SequenceEditor initial={view({ judge: { unsupported_claims: [] } })} />);
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(false);
    // Typing makes the text unsaved: Approve is disabled again.
    fireEvent.change(screen.getByLabelText("Email 2 body"), { target: { value: "Hi,\nChanged. Does that help?" } });
    expect(approve.disabled).toBe(true);
    await waitFor(() => expect(screen.getByText("Save your changes first.")).toBeTruthy());
  });
});

describe("export blocking", () => {
  it("shows a clear block message and no download while blocked", () => {
    const blocked: ExportView = { mode: "ready", blocked: ["Fill in these settings first: opt_out_line, physical_address."], rowCount: 0, readyCount: 0, draftCount: 0, excluded: [], csv: "" };
    render(<ExportPanel data={blocked} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Export is blocked.*opt_out_line, physical_address/);
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("lists suppressed leads that were left out, and offers the CSV", () => {
    const ok: ExportView = { mode: "ready", blocked: [], rowCount: 1, readyCount: 1, draftCount: 1, excluded: [{ lead_id: "paste-doe", firm_name: "Doe Tax", reason: "on the suppression list (doetax.example)" }], csv: "lead_id,firm_name\r\nlead-smith,Smith Tax\r\n" };
    render(<ExportPanel data={ok} />);
    expect(screen.getByText("Doe Tax: on the suppression list (doetax.example)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    expect((screen.getByLabelText("CSV") as HTMLTextAreaElement).value).toContain("lead-smith");
  });

  it("offers two modes, 'Ready to send' and 'Drafts', with their row counts", () => {
    const onMode = vi.fn();
    const drafts: ExportView = {
      mode: "ready",
      blocked: [],
      rowCount: 1,
      readyCount: 1,
      draftCount: 2,
      excluded: [{ lead_id: "lead-none", firm_name: "No Email CPA", reason: "no public email; add before sending (included in the Drafts export)" }],
      csv: "lead_id,firm_name,to_email,send_ready,contact_note\r\n",
    };
    render(<ExportPanel data={drafts} onMode={onMode} />);
    const ready = screen.getByRole("button", { name: "Ready to send (1)" });
    expect(ready.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Drafts (2)" }));
    expect(onMode).toHaveBeenCalledWith("drafts");
    expect(screen.getByText(/No Email CPA: no public email; add before sending/)).toBeTruthy();
  });
});

describe("override reason", () => {
  it("requires a typed reason of at least 10 characters and sends it trimmed", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<ReasonForm label="Override for this lead" button="Override" onSubmit={onSubmit} />);
    const button = screen.getByRole("button", { name: "Override" }) as HTMLButtonElement;
    const box = screen.getByLabelText(/Override for this lead/);
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "too short" } });
    expect(button.disabled).toBe(true);
    expect(screen.getByText(`Type a reason of at least ${MIN_REASON} characters.`)).toBeTruthy();
    fireEvent.change(box, { target: { value: "  Solo practice; the owner reads info@  " } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Solo practice; the owner reads info@"));
  });

  it("shows the server's plain error when the override is refused", async () => {
    render(<ReasonForm label="Override" button="Override" onSubmit={async () => Promise.reject(new Error("Lead x was not found."))} />);
    fireEvent.change(screen.getByLabelText(/Override/, { selector: "textarea" }), { target: { value: "A good long reason here" } });
    fireEvent.click(screen.getByRole("button", { name: "Override" }));
    await waitFor(() => expect(screen.getByText("Lead x was not found.")).toBeTruthy());
  });
});
