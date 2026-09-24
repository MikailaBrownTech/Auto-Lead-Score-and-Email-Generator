import type Anthropic from "@anthropic-ai/sdk";
import { countWords, EXTRACTION_TOOL_NAME } from "@clearpath/shared";
import { vi } from "vitest";
import type { PriceTable } from "../../src/config/prices";
import type { MessagesApi } from "../../src/llm/client";

export const TEST_MODEL = "test-haiku";

export const testPrices: PriceTable = {
  source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checked_on: "2026-09-23",
  currency: "USD",
  unit: "per_million_tokens",
  notes: [],
  tokenizer_note: { text: "t", source_url: "https://platform.claude.com/x", checked_on: "2026-09-23" },
  models: { [TEST_MODEL]: { input: 1, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1, output: 5, tokenizer: "previous" } },
  aliases: {},
};

/** Deterministic stand-in for count_tokens: one token per word of the user content. */
function fakeCount(p: Anthropic.MessageCountTokensParams): number {
  const content = p.messages[0]?.content;
  const text = typeof content === "string" ? content : JSON.stringify(content);
  return countWords(text) + (p.system ? 500 : 0) + (p.tools ? 500 : 0);
}

export type Responder = (params: Anthropic.MessageCreateParamsNonStreaming, callIndex: number) => Record<string, unknown> | Anthropic.Message | Error;

/** A fake Messages API: each create() returns a record_dossier tool call built by the responder. */
export function fakeApi(responder: Responder) {
  let n = 0;
  const create = vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
    const i = n++;
    const r = responder(params, i);
    if (r instanceof Error) throw r;
    if ((r as Anthropic.Message).type === "message") return r as Anthropic.Message;
    return {
      id: `msg_${i}`,
      type: "message",
      role: "assistant",
      model: params.model,
      content: [{ type: "tool_use", id: `toolu_${i}`, name: EXTRACTION_TOOL_NAME, input: r }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: i > 0 ? 3000 : 0, cache_creation_input_tokens: i === 0 ? 3000 : 0 },
    } as unknown as Anthropic.Message;
  });
  const countTokens = vi.fn(async (p: Anthropic.MessageCountTokensParams) => ({ input_tokens: fakeCount(p) }));
  const api = { messages: { create, countTokens } } as unknown as MessagesApi;
  return { api, create, countTokens };
}

export function userText(params: Anthropic.MessageCreateParamsNonStreaming): string {
  const c = params.messages[0]!.content;
  return typeof c === "string" ? c : JSON.stringify(c);
}

const HOME = "https://smithtax.example/";
const ABOUT = "https://smithtax.example/about";
const SERVICES = "https://smithtax.example/services";
const PRIVACY = "https://smithtax.example/privacy-policy";

const ev = (value: unknown, url: string, quote: string) => ({ value, evidence_url: url, evidence_quote: quote });

/** A correct answer for the smithtax.example fixture: every quote is copied from the fixture pages. */
export function smithAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firm_name: ev("Smith Tax Services", HOME, "Smith Tax Services"),
    firm_type: ev({ primary: "tax_preparer", secondary: ["payroll"] }, HOME, "Tax preparation for individuals and small businesses in Columbus, Ohio since 2004."),
    location: ev({ city: "Columbus", state: "OH", country: "US" }, HOME, "small businesses in Columbus, Ohio since 2004"),
    size_signal: ev({ staff_count: 6, text: "team of six" }, ABOUT, "Today our team of six includes three enrolled agents"),
    services: ["Individual tax returns", "Payroll services"],
    software_mentioned: ["Drake Tax"],
    client_portal_or_doc_exchange: ev({ doc_exchange: true, secure_portal: false }, HOME, "Email us your documents or drop them off at the office."),
    people: [{ name: "Jane Smith", title: null, evidence_url: ABOUT, evidence_quote: "Jane Smith, EA, founded the firm in 2004" }],
    public_contact_email: ev({ address: "office@smithtax.example", owner_name: null }, HOME, "or email office@smithtax.example"),
    personal_email_domain_on_site: ev("smithtaxes@gmail.com", HOME, "After hours: smithtaxes@gmail.com"),
    privacy_policy_present: ev(true, PRIVACY, "Privacy Policy"),
    security_or_wisp_mention: "NOT_FOUND",
    client_count_signal: "NOT_FOUND",
    phone_or_contact_form: ev({ phone: "(614) 555-0100", contact_form: false }, HOME, "Call (614) 555-0100"),
    exclusion_signals: [],
    suspected_prompt_injection: false,
    ...overrides,
  };
}

/** A retry answer: NOT_FOUND everywhere except the given fields. */
export function onlyFields(fields: Record<string, unknown>): Record<string, unknown> {
  const blank = Object.fromEntries(Object.keys(smithAnswer()).map((k) => [k, k === "people" || k === "exclusion_signals" ? [] : "NOT_FOUND"]));
  return { ...blank, suspected_prompt_injection: false, ...fields };
}

export const SMITH = { HOME, ABOUT, SERVICES, PRIVACY };
