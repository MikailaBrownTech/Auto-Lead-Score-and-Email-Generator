// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JobView } from "@clearpath/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { leads } from "../../server/src/db/schema";
import { strongDossier } from "../../server/test/fixtures/dossiers";
import { makeHarness } from "../../server/test/fixtures/app-harness";
import { App } from "./App";
import { JobStatus } from "./pages/Import";

// Renders as an already-signed-in user; wireFetch below bypasses the browser's real Authorization
// header anyway (it routes straight into the harness's own fixed headers).
vi.mock("./auth", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ session: { user: { email: "founder@example.com" } } }),
}));

type Harness = ReturnType<typeof makeHarness>;

/** Routes the browser's fetch to the in-process API (as the Vite proxy does), with optional overrides. */
function wireFetch(h: Harness, override?: (method: string, url: string) => Response | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const forced = override?.(method, url);
      if (forced) return forced;
      const r = await h.call(method, url, init?.body ? JSON.parse(String(init.body)) : undefined);
      return new Response(r.json ? JSON.stringify(r.json) : r.text, { status: r.status, headers: { "content-type": r.json ? "application/json" : "text/csv" } });
    }),
  );
}

let h: Harness | null = null;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  h?.cleanup();
  h = null;
});

function open(hash: string) {
  window.location.hash = hash;
  render(<App />);
}

describe("Write sequence, end to end in the UI", { timeout: 60_000 }, () => {
  it("import a fixture lead, click Write, and a sequence appears", async () => {
    h = makeHarness();
    wireFetch(h);
    open("#/import");
    fireEvent.change(await screen.findByPlaceholderText(/smithtax\.com/), { target: { value: "smithtax.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    const link = await screen.findByRole("link", { name: "smithtax.example" }, { timeout: 20_000 });
    fireEvent.click(link);
    // Clicking the link changes the hash; the App follows it.
    await waitFor(() => expect(window.location.hash).toBe("#/leads/lead-smithtax-example"));
    const write = await screen.findByRole("button", { name: /Write/ }, { timeout: 10_000 });
    expect((write as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(write);
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/sequences\/\d+$/), { timeout: 20_000 });
    await waitFor(() => expect(document.querySelectorAll("article.email-card").length).toBe(5), { timeout: 10_000 });
    expect(screen.getByText(/Sequence for Smith Tax Services/)).toBeTruthy();
  });

  it("a gated lead shows the reason in words next to the disabled button", async () => {
    h = makeHarness();
    const d = strongDossier({ gate: { status: "out_of_icp", reasons: ["staff count 150 is above max_staff_for_sequence 60"] } });
    h.db.insert(leads).values({ id: "L-out", source: "web", status: "extracted", tier: "A", score: 80, gateStatus: "out_of_icp", dossierJson: JSON.stringify(d) }).run();
    wireFetch(h);
    open("#/leads/L-out");
    const reason = await screen.findByText(/Not written: this lead is out of ICP \(staff count 150/, undefined, { timeout: 10_000 });
    expect(reason.closest("[role=status]")).toBeTruthy();
    expect(reason.textContent).toMatch(/Approve it with a reason to write anyway/);
    expect((screen.getByRole("button", { name: /Write sequence/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  for (const [status, body, expected] of [
    [401, { error: "unauthorized" }, /security token did not match \(401\).*npm run app/],
    [403, { error: "forbidden_origin" }, /refused a request from this page's address \(403\)/],
    [500, { error: "Something went wrong: boom" }, /Something went wrong: boom/],
    [502, null, /did not answer properly \(HTTP 502\)/],
  ] as const) {
    it(`a ${status} from the write route shows a visible error banner`, async () => {
      h = makeHarness();
      h.db.insert(leads).values({ id: "L-ok", source: "web", status: "extracted", tier: "A", score: 80, gateStatus: "qualified", dossierJson: JSON.stringify(strongDossier()) }).run();
      wireFetch(h, (method, url) =>
        method === "POST" && url.endsWith("/sequence") ? new Response(body ? JSON.stringify(body) : "Bad Gateway", { status, headers: { "content-type": body ? "application/json" : "text/plain" } }) : null,
      );
      open("#/leads/L-ok");
      fireEvent.click(await screen.findByRole("button", { name: /Write sequence/ }, { timeout: 10_000 }));
      const alert = await screen.findByRole("alert", undefined, { timeout: 10_000 });
      expect(alert.textContent).toMatch(expected);
      expect(window.location.hash).toBe("#/leads/L-ok");
    });
  }
});

describe("a job that does not finish is never silent", () => {
  it("shows a still-working notice after a few minutes", () => {
    const job: JobView = {
      id: "j",
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      items: [{ leadId: "lead-x", label: "x.example", state: "writing", message: "Writing the custom emails" }],
      cancelRequested: false,
      finished: false,
    };
    render(<JobStatus job={job} />);
    expect(screen.getByRole("status").textContent).toMatch(/Still working after 5 minutes/);
  });
});
