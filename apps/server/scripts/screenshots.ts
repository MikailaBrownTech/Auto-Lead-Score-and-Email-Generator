/**
 * npm run screenshots: builds the web UI, serves it with the whole API in-process on seed data
 * (saved HTML fixtures, fake DNS, recorded model answers; no network, no API key, no spend), and
 * captures every screen with Playwright at 1280px into data/screenshots/. Also writes 900px and
 * dark-theme variants into data/screenshots/900/ and data/screenshots/dark/ for layout checks, and
 * reports any page that scrolls sideways.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { Dossier } from "@clearpath/shared";
import { NOT_FOUND } from "@clearpath/shared";
import { chromium, type Page } from "playwright";
import { fromRoot } from "../src/config/paths";
import { leads } from "../src/db/schema";
import { loadScoring } from "../src/docs/loader";
import { scoreDossier } from "../src/scoring/score";
import { DOE_TEXT, makeHarness, NOW, PORT, TOKEN } from "../test/fixtures/app-harness";
import { ev, strongDossier } from "../test/fixtures/dossiers";
import { TOKEN_HEADER } from "../src/server/local-guard";

const OUT = fromRoot("data/screenshots");
const DIST = fromRoot("apps/web/dist");

type Harness = ReturnType<typeof makeHarness>;

function build(): void {
  console.log("building the web UI ...");
  const r = spawnSync("npm", ["run", "build", "-w", "@clearpath/web"], { cwd: fromRoot("."), stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error("web build failed");
}

/** A lead saved straight into the database, scored the same way the pipeline scores it. */
function addLead(h: Harness, id: string, d: Dossier, status: "extracted" | "no_named_contact") {
  const dossier = { ...d, lead_id: id };
  const score = scoreDossier(dossier, loadScoring(h.docsDir), NOW);
  h.db
    .insert(leads)
    .values({
      id,
      source: "web",
      inputUrl: d.url,
      status,
      dossierJson: JSON.stringify(dossier),
      score: score.total,
      tier: score.tier,
      gateStatus: dossier.gate.status,
      gateReasonsJson: JSON.stringify(dossier.gate.reasons),
      incompleteData: score.incompleteData.flag,
    })
    .run();
}

function site(domain: string) {
  const home = `https://www.${domain}/`;
  const about = `https://www.${domain}/about`;
  return { home, about, url: home, domain, pages_opened: [home, about, `https://www.${domain}/services`, `https://www.${domain}/privacy-policy`] };
}

/** Five leads that cover every contact case, a gate, a validator failure, and both export modes. */
async function seed(h: Harness) {
  const ok = async (method: string, url: string, body?: unknown) => {
    const r = await h.call(method, url, body);
    if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  await ok("PUT", "/api/settings/offer", { opt_out_line: "If this isn't relevant, reply 'no' and I won't email again.", physical_address: "100 E Broad St, Columbus, OH 43215", checklist_ready: true });

  // Researched through the real pipeline (fixture site + recorded answers): generic inbox; named owner (paste).
  await ok("POST", "/api/jobs", { mode: "web", urls: ["smithtax.example"] });
  await ok("POST", "/api/jobs", { mode: "paste", label: "Doe Tax", text: DOE_TEXT });
  await h.jobs.idle();

  // Named contact, tier A (every email model-written).
  const maple = site("maplestreetcpas.example");
  addLead(
    h,
    "lead-maplestreetcpas-example",
    strongDossier({
      ...maple,
      firm_name: ev("Maple Street CPAs", "Maple Street CPAs", maple.home),
      firm_type: ev({ primary: "cpa" as const, secondary: [] }, "Maple Street CPAs is a certified public accounting firm", maple.home),
      location: ev({ city: "Dayton", state: "OH", country: "US" }, "Proudly serving Dayton, Ohio", maple.home),
      people: [{ name: "Jane Smith", title: "Managing Partner", evidence_url: maple.about, evidence_quote: "Jane Smith, CPA, Managing Partner" }],
      decision_maker: ev({ name: "Jane Smith", title: "Managing Partner", role_confirmed: true }, "Jane Smith, CPA, Managing Partner", maple.about),
      public_contact_email: ev({ address: "jane@maplestreetcpas.example", owner_name: "Jane Smith" }, "Jane Smith, CPA: jane@maplestreetcpas.example", maple.about),
      target_industry_fit: { value: true, reason: "primary type cpa is a target type", qualifying_type: "cpa" },
    }),
    "extracted",
  );

  // No public email at all, bookkeeper; several facts NOT_FOUND (gray "unknown" bars).
  const buckeye = site("buckeyebooks.example");
  addLead(
    h,
    "lead-buckeyebooks-example",
    strongDossier({
      ...buckeye,
      firm_name: ev("Buckeye Bookkeeping", "Buckeye Bookkeeping", buckeye.home),
      firm_type: ev({ primary: "bookkeeper" as const, secondary: [] }, "Monthly bookkeeping for small businesses", buckeye.home),
      location: ev({ city: "Akron", state: "OH", country: "US" }, "Based in Akron, Ohio", buckeye.home),
      size_signal: NOT_FOUND,
      people: [],
      decision_maker: NOT_FOUND,
      public_contact_email: NOT_FOUND,
      public_email_kind: NOT_FOUND,
      personal_email_domain_on_site: NOT_FOUND,
      software_mentioned: NOT_FOUND,
      client_portal_or_doc_exchange: NOT_FOUND,
      phone_or_contact_form: ev({ phone: null, contact_form: true as const }, "Send us a message", buckeye.home),
      services: { value: ["Monthly bookkeeping", "Payroll services"], evidence: [{ item: "Monthly bookkeeping", evidence_url: buckeye.home }, { item: "Payroll services", evidence_url: buckeye.home }] },
      target_industry_fit: { value: true, reason: "primary type bookkeeper is a target type", qualifying_type: "bookkeeper" },
      failures: ["https://www.buckeyebooks.example/team: skipped (404)"],
    }),
    "no_named_contact",
  );

  // Out of ICP by size: gated until the founder approves it.
  const lake = site("lakeshoreaccounting.example");
  addLead(
    h,
    "lead-lakeshoreaccounting-example",
    strongDossier({
      ...lake,
      firm_name: ev("Lakeshore Accounting Partners", "Lakeshore Accounting Partners", lake.home),
      firm_type: ev({ primary: "cpa" as const, secondary: [] }, "a full-service CPA firm", lake.home),
      location: ev({ city: "Cleveland", state: "OH", country: "US" }, "Offices in Cleveland, Ohio", lake.home),
      size_signal: ev({ staff_count: 85, text: "85 professionals" }, "our 85 professionals", lake.about),
      public_contact_email: ev({ address: "info@lakeshoreaccounting.example", owner_name: null }, "info@lakeshoreaccounting.example", lake.home),
      public_email_kind: "generic_inbox",
      gate: { status: "out_of_icp", reasons: ["staff count 85 is above max_staff_for_sequence 60"] },
    }),
    "no_named_contact",
  );

  const smith = await ok("GET", "/api/leads/lead-smithtax-example");
  const doe = await ok("GET", "/api/leads/paste-doe-tax");
  const mapleSeq = await ok("POST", "/api/leads/lead-maplestreetcpas-example/sequence");
  const buckeyeSeq = await ok("POST", "/api/leads/lead-buckeyebooks-example/sequence");
  for (const id of [smith.sequenceId, doe.sequenceId, buckeyeSeq.id]) {
    const v = await ok("GET", `/api/sequences/${id}`);
    if (v.judgeRequired && !v.judge) await ok("POST", `/api/sequences/${id}/judge`);
    await ok("POST", `/api/sequences/${id}/approve`);
  }
  // A founder edit that breaks two rules, so the sequence screen shows inline errors and a disabled Approve.
  const emails = (mapleSeq.sequence.emails as { n: number; subject_a: string | null; subject_b: string | null; body: string }[]).map((e) =>
    e.n === 1 ? { ...e, subject_a: "Quick question for Maple Street CPAs team" } : e.n === 2 ? { ...e, body: `${e.body} Great news!` } : e,
  );
  await ok("PUT", `/api/sequences/${mapleSeq.id}`, { emails });
  return { smithSeq: smith.sequenceId as number, mapleSeq: mapleSeq.id as number };
}

/** Serves the built UI and forwards /api to the in-process API with the local token, as the Vite proxy does. */
function start(h: Harness): Promise<{ url: string; close: () => void }> {
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  return new Promise((resolve) => {
    const server = serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (req) => {
          const u = new URL(req.url);
          if (u.pathname.startsWith("/api/")) {
            const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
            return h.app.request(`http://127.0.0.1:${PORT}${u.pathname}${u.search}`, {
              method: req.method,
              headers: { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN, "content-type": "application/json" },
              ...(body ? { body } : {}),
            });
          }
          const file = path.join(DIST, u.pathname === "/" ? "index.html" : decodeURIComponent(u.pathname));
          if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return new Response("not found", { status: 404 });
          return new Response(fs.readFileSync(file), { headers: { "content-type": types[path.extname(file)] ?? "application/octet-stream" } });
        },
      },
      (info) => resolve({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }),
    );
  });
}

async function shoot(page: Page, base: string, hash: string, file: string, ready: string, before?: (p: Page) => Promise<void>): Promise<string | null> {
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector(ready, { timeout: 15_000 });
  await page.waitForFunction(() => !document.querySelector("[aria-busy=true]") && !/Spend: loading/.test(document.body.textContent ?? ""), undefined, { timeout: 15_000 });
  if (before) await before(page);
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  return overflow > 0 ? `${path.basename(file)}: page scrolls sideways by ${overflow}px` : null;
}

async function main() {
  build();
  const h = makeHarness();
  const empty = makeHarness();
  const { smithSeq, mapleSeq } = await seed(h);
  const app = await start(h);
  const blank = await start(empty);
  const screens: [string, string, string, ((p: Page) => Promise<void>)?][] = [
    ["01-import.png", "#/import", "text=Website addresses"],
    ["02-leads.png", "#/leads", "table.data"],
    ["03-lead-generic-inbox.png", "#/leads/lead-smithtax-example", "[aria-label=Scorecard]"],
    ["04-lead-named-contact.png", "#/leads/lead-maplestreetcpas-example", "[aria-label=Scorecard]"],
    ["05-lead-no-email.png", "#/leads/lead-buckeyebooks-example", "[aria-label=Scorecard]"],
    ["06-lead-gated.png", "#/leads/lead-lakeshoreaccounting-example", "[aria-label=Scorecard]"],
    ["07-sequences.png", "#/sequences", "table.data"],
    ["08-sequence-with-errors.png", `#/sequences/${mapleSeq}`, "article.email-card"],
    ["09-sequence-approved.png", `#/sequences/${smithSeq}`, "article.email-card"],
    ["10-export-ready.png", "#/export", ".segmented"],
    ["11-export-drafts.png", "#/export", ".segmented", async (p) => {
      await p.getByRole("button", { name: /^Drafts/ }).click();
      await p.waitForFunction(() => document.querySelector('.segmented button[aria-pressed="true"]')?.textContent?.startsWith("Drafts"));
      await p.waitForFunction(() => (document.querySelector("textarea.csv") as HTMLTextAreaElement | null)?.value.includes(",N,"));
    }],
    ["12-settings.png", "#/settings", "text=Suppression list"],
  ];
  const problems: string[] = [];
  const browser = await chromium.launch();
  try {
    for (const [dir, width, scheme] of [["", 1280, "light"], ["900", 900, "light"], ["dark", 1280, "dark"]] as const) {
      const out = path.join(OUT, dir);
      fs.mkdirSync(out, { recursive: true });
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
      for (const [file, hash, ready, before] of screens) {
        const p = await shoot(page, app.url, hash, path.join(out, file), ready, before);
        if (p) problems.push(`${dir || "1280"}/${p}`);
      }
      const p = await shoot(page, blank.url, "#/leads", path.join(out, "00-leads-empty.png"), ".empty");
      if (p) problems.push(`${dir || "1280"}/${p}`);
      await page.close();
    }
  } finally {
    await browser.close();
    app.close();
    blank.close();
    h.cleanup();
    empty.cleanup();
  }
  console.log(problems.length ? `LAYOUT PROBLEMS:\n${problems.join("\n")}` : "no horizontal page scroll on any screen");
  console.log(`screenshots: ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
