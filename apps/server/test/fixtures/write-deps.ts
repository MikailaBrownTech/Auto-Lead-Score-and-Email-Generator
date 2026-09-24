import type Anthropic from "@anthropic-ai/sdk";
import { JUDGE_TOOL_NAME, PERSONAL_LINE_TOOL_NAME, type OfferConfig } from "@clearpath/shared";
import type { Db } from "../../src/db/client";
import { loadApprovedSentences, loadEvidence, loadOffer, loadStyle, loadWriterFacts } from "../../src/docs/loader";
import { loadTemplates } from "../../src/docs/templates";
import { createLlmClient } from "../../src/llm/client";
import { SpendGate } from "../../src/llm/spend-gate";
import type { WriteDeps } from "../../src/write/generate";
import { loadJudgeSystemPrompt, loadPersonalLineSystemPrompt } from "../../src/write/prompt";
import { fakeApi, testPrices, TEST_MODEL, type Responder } from "./fakeapi";

export const style = loadStyle();
export const offer = loadOffer();
export const evidence = loadEvidence();
export const templates = loadTemplates();
export const facts = loadWriterFacts();
export const approved = loadApprovedSentences().sentences;

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

/** A tool_use message for the named tool (personal line or judge). */
export function toolMessage(name: string, input: unknown, i: number): Anthropic.Message {
  return {
    id: `msg_${i}`,
    type: "message",
    role: "assistant",
    model: TEST_MODEL,
    content: [{ type: "tool_use", id: `toolu_${i}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 700, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

/** Personal-line answers for personal-line calls, the judge answer for judge calls (by tool name). */
export function scripted(lines: unknown[], judgment: unknown = { unsupported_claims: [] }): Responder {
  let k = 0;
  return (p, i) => {
    const tool = (p.tools![0] as Anthropic.Tool).name;
    if (tool === PERSONAL_LINE_TOOL_NAME) return toolMessage(tool, lines[Math.min(k++, lines.length - 1)], i);
    if (tool === JUDGE_TOOL_NAME) return toolMessage(tool, judgment, i);
    throw new Error(`unexpected tool ${tool}`);
  };
}

/** WriteDeps over a fake Messages API (no network, no spend). */
export function testWriteDeps(db: Db, responder: Responder = scripted([{ personal_line: "unused." }]), over: Partial<WriteDeps> = {}, capUsd = 5) {
  const f = fakeApi(responder);
  const now = () => new Date("2026-09-24T12:00:00Z");
  const llm = createLlmClient({ api: f.api, db, prices: testPrices, gate: new SpendGate(db, capUsd, now), leadTokenBudget: 1_000_000, backoff: { sleep: async () => undefined } });
  const deps: WriteDeps = {
    db,
    llm,
    modelLine: TEST_MODEL,
    lineSystem: loadPersonalLineSystemPrompt(style),
    modelJudge: TEST_MODEL,
    judgeSystem: loadJudgeSystemPrompt({ offer: over.offer ?? offer, facts }),
    style,
    offer,
    evidence,
    templates,
    facts,
    approved,
    ...over,
  };
  return { deps, ...f };
}
