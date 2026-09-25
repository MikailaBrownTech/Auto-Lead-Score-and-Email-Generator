import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_TOOL_NAME, WRITER_TOOL_NAME, type OfferConfig, type WriterOutput } from "@clearpath/shared";
import type { Db } from "../../src/db/client";
import { loadApprovedSentences, loadEvidence, loadOffer, loadStyle, loadWriterFacts } from "../../src/docs/loader";
import { loadTemplates } from "../../src/docs/templates";
import { createLlmClient } from "../../src/llm/client";
import { SpendGate } from "../../src/llm/spend-gate";
import { writerSystemFor } from "../../src/server/services";
import type { WriteDeps } from "../../src/write/generate";
import { loadJudgeSystemPrompt, loadPersonaHeadings } from "../../src/write/prompt";
import { fakeApi, testPrices, TEST_MODEL, userText, type Responder } from "./fakeapi";

export const style = loadStyle();
export const offer = loadOffer();
export const evidence = loadEvidence();
export const templates = loadTemplates();
export const facts = loadWriterFacts();
export const approved = loadApprovedSentences().sentences;
export const personas = loadPersonaHeadings();

/** docs/01 with every setting the emails and export need filled in (test values only). */
export const READY_OFFER: OfferConfig = {
  ...offer,
  opt_out_line: "If this isn't relevant, reply 'no' and I won't email again.",
  physical_address: "100 E Broad St, Columbus, OH 43215",
  founding_client_offer: "half off the first three months",
  booking_link: "https://cal.example.com/clearpath/15min",
  region: "Columbus-area",
  checklist_ready: true,
};

/** A tool_use message for the named tool (writer or judge). */
export function toolMessage(name: string, input: unknown, i: number): Anthropic.Message {
  return {
    id: `msg_${i}`,
    type: "message",
    role: "assistant",
    model: TEST_MODEL,
    content: [{ type: "tool_use", id: `toolu_${i}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 700, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/**
 * A writer answer that passes the validators for any lead, built from the writer's own user message
 * the way the real model reads it: the firm's name, the greeting rule, and whether an approved sentence
 * (and so the [[APPROVED]] marker) is expected.
 */
export function writerAnswerFor(message: string): WriterOutput {
  const firm = /"firm_name":\s*"([^"]+)"/.exec(message)?.[1] ?? "your firm";
  const first = /the public address belongs to ([^.]+)\. Email 1 starts/.exec(message)?.[1] ?? null;
  const marker = /where you put \[\[APPROVED\]\] in email 2/.test(message);
  const e1 = first
    ? `Hi ${first},\n\nQuick question about client data at ${firm}: has anyone asked you for a written information security plan yet?\n\nI help small firms get that written down, along with the basic security behind it. If someone else handles this, could you point me their way?`
    : `Quick question for whoever handles client data at ${firm}: has anyone asked you for a written information security plan yet?\n\nI help small firms get that written down, along with the basic security behind it. If someone else handles this, could you point me their way?`;
  return {
    emails: [
      { n: 1, subject_a: `written security plan at ${firm}?`, subject_b: "quick question about client data", body: e1 },
      {
        n: 2,
        subject_a: null,
        subject_b: null,
        body: `Following up with the short list of what's usually expected: a written plan, one person responsible for it, multi-factor authentication, and a plan for when something goes wrong.${marker ? "\n\n[[APPROVED]]" : ""}\n\nMost firms have pieces of this already, just not written down. Curious where things stand.`,
      },
      { n: 3, subject_a: null, subject_b: null, body: "I put together a one-page checklist in plain language, so you can check where things stand in about ten minutes. Want me to send it over?" },
      { n: 4, subject_a: "a founding-client offer", subject_b: null, body: "I'm taking on a small group of firms at a founding-client rate right now, in exchange for honest feedback.\n\nIf it's useful, here's my calendar: {{booking_link}}" },
      { n: 5, subject_a: null, subject_b: null, body: "I'll leave this here for now. If a written plan ever comes up, reply anytime and I'll send the checklist over." },
    ],
  };
}

/**
 * Writer answers for writer calls (a list, in order; a function gets the call's user message), the
 * judge answer for judge calls (by tool name).
 */
export function scripted(writer: unknown[] | ((message: string, call: number) => unknown) = (m) => writerAnswerFor(m), judgment: unknown | unknown[] = { unsupported_claims: [] }): Responder {
  let w = 0;
  let j = 0;
  return (p, i) => {
    const tool = (p.tools![0] as Anthropic.Tool).name;
    if (tool === WRITER_TOOL_NAME) {
      const k = w++;
      return toolMessage(tool, typeof writer === "function" ? writer(userText(p), k) : writer[Math.min(k, writer.length - 1)], i);
    }
    if (tool === JUDGE_TOOL_NAME) {
      const list = Array.isArray(judgment) ? judgment : [judgment];
      return toolMessage(tool, list[Math.min(j++, list.length - 1)], i);
    }
    throw new Error(`unexpected tool ${tool}`);
  };
}

/** WriteDeps over a fake Messages API (no network, no spend). */
export function testWriteDeps(db: Db, responder: Responder = scripted(), over: Partial<WriteDeps> = {}, capUsd = 5) {
  const f = fakeApi(responder);
  const now = () => new Date("2026-09-24T12:00:00Z");
  const llm = createLlmClient({ api: f.api, db, prices: testPrices, gate: new SpendGate(db, capUsd, now), leadTokenBudget: 1_000_000, backoff: { sleep: async () => undefined } });
  const o = over.offer ?? offer;
  const deps: WriteDeps = {
    db,
    llm,
    modelWrite: TEST_MODEL,
    writerSystem: writerSystemFor({ offer: o, facts, style }),
    judgeSystem: loadJudgeSystemPrompt({ offer: o, facts }),
    style,
    offer,
    evidence,
    templates,
    facts,
    approved,
    personas,
    ...over,
  };
  return { deps, ...f };
}
