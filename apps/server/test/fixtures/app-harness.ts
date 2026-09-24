import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { EXTRACTION_TOOL_NAME, JUDGE_TOOL_NAME, WRITER_TOOL_NAME } from "@clearpath/shared";
import type { DnsResolver } from "../../src/dns/lookup";
import { openDb } from "../../src/db/client";
import { fromRoot } from "../../src/config/paths";
import { createLlmClient } from "../../src/llm/client";
import { SpendGate } from "../../src/llm/spend-gate";
import { createApp } from "../../src/server/app";
import { JobRunner } from "../../src/server/jobs";
import { TOKEN_HEADER } from "../../src/server/local-guard";
import type { Services } from "../../src/server/services";
import { fakeApi, smithAnswer, testPrices, TEST_MODEL, userText } from "./fakeapi";
import { fakeLimiter, sampleWeb } from "./fakeweb";

export const PORT = 8787;
export const TOKEN = "t".repeat(64);
export const NOW = new Date("2026-09-24T12:00:00.000Z");

export const DOE_TEXT = [
  "Doe Tax Service",
  "Jane Doe, owner: jane@doetax.example",
  "Doe Tax Service offers tax preparation and payroll services for local businesses in Dayton, Ohio.",
  "Call (937) 555-0100.",
].join("\n\n");

const P = "pasted";
const ev = (value: unknown, quote: string) => ({ value, evidence_url: P, evidence_quote: quote });

/** The recorded extraction answer for DOE_TEXT (paste mode: every evidence_url is "pasted"). */
export function doeAnswer(): Record<string, unknown> {
  return {
    firm_name: ev("Doe Tax Service", "Doe Tax Service"),
    firm_type: ev({ primary: "tax_preparer", secondary: [] }, "Doe Tax Service offers tax preparation and payroll services"),
    location: ev({ city: "Dayton", state: "OH", country: "US" }, "for local businesses in Dayton, Ohio."),
    size_signal: "NOT_FOUND",
    client_count_signal: "NOT_FOUND",
    services: ["tax preparation", "payroll services"],
    software_mentioned: "NOT_FOUND",
    client_portal_or_doc_exchange: "NOT_FOUND",
    people: [{ name: "Jane Doe", title: "owner", evidence_url: P, evidence_quote: "Jane Doe, owner: jane@doetax.example" }],
    public_contact_email: ev({ address: "jane@doetax.example", owner_name: "Jane Doe" }, "Jane Doe, owner: jane@doetax.example"),
    personal_email_domain_on_site: "NOT_FOUND",
    privacy_policy_present: "NOT_FOUND",
    security_or_wisp_mention: "NOT_FOUND",
    phone_or_contact_form: ev({ phone: "(937) 555-0100", contact_form: null }, "Call (937) 555-0100."),
    exclusion_signals: [],
    suspected_prompt_injection: false,
  };
}

/** A writer answer that passes the validators for any lead and any set of emails (email 1 names "your firm"). */
export const WRITER_ANSWER = {
  emails: [
    { n: 1, subject_a: "security plan question", subject_b: "client data question", opening: "I noticed your firm works with local clients.", closing: "Is a written security plan something you keep on file?" },
    { n: 2, subject_a: null, subject_b: null, opening: "Following up on my last note.", closing: "Would a short outline help?" },
    { n: 3, subject_a: null, subject_b: null, opening: "I put together a one-page checklist in plain language that you can check your firm against. Want me to send it over?", closing: "" },
    { n: 4, subject_a: null, subject_b: null, opening: "Here is the short version.", closing: "If you want a second set of eyes, you can book an assessment here: https://www.clearpathsecure.com/contact" },
    { n: 5, subject_a: null, subject_b: null, opening: "I will assume the timing is not right and stop here. If a written plan comes up later, just reply.", closing: "" },
  ],
};

/**
 * WRITER_ANSWER with email 1 naming the firm from the writer message (as the real writer does), so a
 * neutral greeting still passes the "never a generic email 1" rule.
 */
export function writerAnswerFor(writerMessage: string): typeof WRITER_ANSWER {
  const firm = /"firm_name":\s*"([^"]+)"/.exec(writerMessage)?.[1];
  if (!firm) return WRITER_ANSWER;
  return { emails: WRITER_ANSWER.emails.map((e) => (e.n === 1 ? { ...e, opening: `I noticed ${firm} works with local clients.` } : e)) };
}

function message(name: string, input: unknown, i: number): Anthropic.Message {
  return {
    id: `msg_${i}`,
    type: "message",
    role: "assistant",
    model: TEST_MODEL,
    content: [{ type: "tool_use", id: `toolu_${i}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

const fakeDns: DnsResolver = {
  resolveMx: async () => [{ exchange: "aspmx.l.google.com", priority: 1 }],
  resolveTxt: async (name) => {
    if (name.startsWith("_dmarc.")) throw Object.assign(new Error("queryTxt ENOTFOUND"), { code: "ENOTFOUND" });
    return [["v=spf1 include:_spf.google.com ~all"]];
  },
};

/**
 * The whole API in-process: saved HTML fixtures (smithtax.example), fake DNS, recorded model answers
 * (extraction, writer, judge by tool name), and a temporary copy of docs/ so settings saves stay local.
 */
export function makeHarness(opts: { judge?: unknown; writer?: unknown | ((call: number) => unknown); capUsd?: number } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clearpath-e2e-"));
  const docsDir = path.join(tmp, "docs");
  fs.cpSync(fromRoot("docs"), docsDir, { recursive: true });
  const db = openDb(":memory:");
  const now = () => NOW;
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let writerCall = 0;
  const f = fakeApi((p, i) => {
    calls.push(p);
    const tool = (p.tools![0] as Anthropic.Tool).name;
    if (tool === EXTRACTION_TOOL_NAME) return message(tool, userText(p).includes("doetax") ? doeAnswer() : smithAnswer(), i);
    if (tool === WRITER_TOOL_NAME) {
      const w = opts.writer;
      return message(tool, typeof w === "function" ? (w as (n: number) => unknown)(writerCall++) : (w ?? writerAnswerFor(userText(p))), i);
    }
    if (tool === JUDGE_TOOL_NAME) return message(tool, opts.judge ?? { unsupported_claims: [] }, i);
    throw new Error(`unexpected tool ${tool}`);
  });
  const gate = new SpendGate(db, opts.capUsd ?? 5, now);
  const llm = createLlmClient({ api: f.api, db, prices: testPrices, gate, leadTokenBudget: 1_000_000, backoff: { sleep: async () => undefined } });
  const web = sampleWeb();
  const services: Services = {
    db,
    llm,
    gate,
    env: { MODEL_EXTRACT: TEST_MODEL, MODEL_WRITE: TEST_MODEL, MAX_TOKENS_PER_PAGE: 6000, MAX_INPUT_TOKENS_PER_LEAD: 30000, FETCH_TIMEOUT_MS: 1000, FETCH_MAX_BYTES: 2_000_000, PAGE_CACHE_DAYS: 7, CONTACT_URL: "https://www.clearpathsecure.com/contact" },
    docsDir,
    backupDir: path.join(tmp, "backups"),
    net: { resolver: web.resolver, transport: web.transport, dns: fakeDns, limiter: fakeLimiter().limiter },
    now,
  };
  const jobs = new JobRunner(services);
  const app = createApp({ guard: { port: PORT, token: TOKEN, allowedOrigins: [] }, gate, db, services, jobs });
  const headers = { host: `127.0.0.1:${PORT}`, [TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(`http://127.0.0.1:${PORT}${url}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const type = res.headers.get("content-type") ?? "";
    return { status: res.status, headers: res.headers, json: type.includes("json") ? ((await res.json()) as any) : null, text: type.includes("json") ? "" : await res.text() };
  };
  return { app, db, jobs, services, calls, call, docsDir, web, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}
