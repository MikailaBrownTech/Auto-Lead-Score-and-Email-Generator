// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DOE_TEXT, makeHarness } from "../../server/test/fixtures/app-harness";
import { App } from "./App";

// Every screen renders as an already-signed-in user; the fetch mock below bypasses the browser's
// real Authorization header anyway (it routes straight into the harness's own fixed headers).
vi.mock("./auth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ session: { user: { email: "founder@example.com" } } }),
}));

/**
 * Every screen rendered against the real in-process API (saved HTML fixtures, recorded model
 * answers). The browser's fetch is routed to the API with the local token, as the Vite proxy does.
 */
let h: ReturnType<typeof makeHarness>;
let leadId = "";
let sequenceId = 0;

beforeAll(async () => {
  h = makeHarness();
  await h.call("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] });
  await h.call("POST", "/api/jobs", { mode: "paste", label: "Doe Tax", text: DOE_TEXT });
  await h.jobs.idle();
  leadId = "lead-smithtax-example";
  sequenceId = (await h.call("GET", `/api/leads/${leadId}`)).json.sequenceId;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const r = await h.call(method, url, body);
      return new Response(r.json ? JSON.stringify(r.json) : r.text, { status: r.status, headers: { "content-type": r.json ? "application/json" : "text/csv" } });
    }),
  );
}, 60_000);

afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

async function at(hash: string, expectText: RegExp) {
  cleanup();
  window.location.hash = hash;
  render(<App />);
  await waitFor(() => expect(screen.getAllByText(expectText).length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(document.body.textContent).not.toMatch(/Something went wrong|stack|TypeError/);
}

describe("every screen renders against the real API", { timeout: 30_000 }, () => {
  it("Import", () => at("#/import", /Website addresses, one per line/));
  it("Leads table with flags and the spend meter", async () => {
    await at("#/leads", /Smith Tax Services/);
    expect(screen.getAllByText("generic inbox: lower reply odds").length).toBeGreaterThan(0);
    expect(screen.getAllByText("no named contact").length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText(/this month/)).toBeTruthy());
  });
  it("Lead detail: scorecard, facts, NOT_FOUND badges, optional contact checklist, internal notes", async () => {
    await at(`#/leads/${leadId}`, /Optional: find an owner name or email to improve reply odds/);
    expect(screen.getAllByText("generic inbox: lower reply odds").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Scorecard")).toBeTruthy();
    expect(screen.getAllByText("NOT_FOUND").length).toBeGreaterThan(0);
    expect(screen.getByText("Internal notes: never used in emails")).toBeTruthy();
    expect(screen.getByText(/Secretary of State business search/)).toBeTruthy();
    for (const group of ["Fit", "Signals", "Reachability"]) expect(screen.getByText(group)).toBeTruthy();
  });
  it("Sequence: five cards, approved sentences marked, contact warning shown but not blocking", async () => {
    await at(`#/sequences/${sequenceId}`, /Email 5/);
    expect(document.querySelectorAll("article.email-card").length).toBe(5);
    expect(document.querySelectorAll("mark.approved").length).toBeGreaterThan(0);
    expect(screen.getByText(/Contact: generic inbox: lower reply odds\. This is a warning only/)).toBeTruthy();
    // Validators and judge passed in the harness: nothing else stands in the way of approval.
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("Export: blocked with a clear message until settings are filled in", () => at("#/export", /Export is blocked/));
  it("Settings: footer fields and the suppression list", async () => {
    await at("#/settings", /Suppression list/);
    expect(screen.getByDisplayValue("ClearPath IT")).toBeTruthy();
    for (const label of ["Founding-client offer", "Booking link", "Region"]) expect(screen.getByText(label)).toBeTruthy();
  });
});
