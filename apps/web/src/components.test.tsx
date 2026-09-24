// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ExportView, SequenceView } from "@clearpath/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MIN_REASON, ReasonForm } from "./components/ReasonForm";
import { ExportPanel } from "./pages/Export";
import { approvalState, SequenceEditor } from "./pages/Sequence";

const APPROVED = "The FTC Safeguards Rule applies to non-bank financial institutions.";

function view(over: Partial<SequenceView> = {}): SequenceView {
  const email = (n: number, template: boolean) => ({
    n,
    send_day: [0, 3, 7, 12, 18][n - 1]!,
    subject_a: n === 1 ? "security plan question" : null,
    subject_b: n === 1 ? "client data question" : null,
    body: n === 1 ? `Hi,\nI noticed your firm works with local clients. ${APPROVED} Is a written plan on file?` : `Hi,\nEmail ${n}. Does that help?`,
    grounding: [],
    template,
  });
  return {
    id: 7,
    leadId: "lead-smith",
    firm: "Smith Tax",
    tier: "B",
    status: "blocked",
    sequence: { lead_id: "lead-smith", tier: "B", persona: "p", angle: "irs_pub_4557_wisp", emails: [email(1, false), email(2, false), email(3, true), email(4, true), email(5, true)] },
    issues: [],
    validationPass: true,
    judgeRequired: true,
    judge: null,
    approvalBlockers: [],
    exportBlockers: [],
    approvedSentences: [{ id: "applies_non_bank", text: APPROVED }],
    rewritable: [1, 2],
    wordLimits: { "1": 75, "2": 90, "3": 90, "4": 80 },
    breakupSentences: { min: 2, max: 3 },
    subjectMaxWords: 5,
    signature: ["Mikaila Brown", "Founder", "ClearPath IT"],
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
    expect(approvalState(view({ judge: { unsupported_claims: [] }, approvalBlockers: ["needs_direct_contact: no public email address was found"] }), false).enabled).toBe(false);
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
    const blocked: ExportView = { blocked: ["Fill in these settings first: opt_out_line, physical_address."], rowCount: 0, excluded: [], csv: "" };
    render(<ExportPanel data={blocked} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Export is blocked.*opt_out_line, physical_address/);
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("lists suppressed leads that were left out, and offers the CSV", () => {
    const ok: ExportView = { blocked: [], rowCount: 1, excluded: [{ lead_id: "paste-doe", firm_name: "Doe Tax", reason: "on the suppression list (doetax.example)" }], csv: "lead_id,firm_name\r\nlead-smith,Smith Tax\r\n" };
    render(<ExportPanel data={ok} />);
    expect(screen.getByText("Doe Tax: on the suppression list (doetax.example)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
    expect((screen.getByLabelText("CSV") as HTMLTextAreaElement).value).toContain("lead-smith");
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
