import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PriceTable } from "../src/config/prices";
import { openDb, type Db } from "../src/db/client";
import { runs } from "../src/db/schema";
import {
  BudgetExceededError,
  createLlmClient,
  leadTokensUsed,
  prefixKey,
  type MessagesApi,
} from "../src/llm/client";
import { SpendCapError, SpendGate } from "../src/llm/spend-gate";
import { apiError } from "./helpers";

const prices: PriceTable = {
  source_url: "https://platform.claude.com/docs/en/about-claude/pricing",
  checked_on: "2026-09-23",
  currency: "USD",
  unit: "per_million_tokens",
  notes: [],
  tokenizer_note: { text: "t", source_url: "https://platform.claude.com/x", checked_on: "2026-09-23" },
  models: {
    "test-model": { input: 1, cache_write_5m: 1.25, cache_write_1h: 2, cache_read: 0.1, output: 5, tokenizer: "newer" },
  },
  aliases: {},
};

function fakeMessage(usage: Partial<Anthropic.Usage>): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text: "ok", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...usage,
    } as Anthropic.Usage,
  } as Anthropic.Message;
}

const params = (maxTokens = 100): Anthropic.MessageCreateParamsNonStreaming => ({
  model: "test-model",
  max_tokens: maxTokens,
  messages: [{ role: "user", content: "hi" }],
});

describe("LLM client", () => {
  let db: Db;
  let gate: SpendGate;
  let create: ReturnType<typeof vi.fn>;
  let countTokens: ReturnType<typeof vi.fn>;
  let api: MessagesApi;

  beforeEach(() => {
    db = openDb(":memory:");
    gate = new SpendGate(db, 1);
    create = vi.fn();
    countTokens = vi.fn().mockResolvedValue({ input_tokens: 50 });
    api = { messages: { create, countTokens } } as unknown as MessagesApi;
  });

  const client = (leadTokenBudget = 1_000_000) =>
    createLlmClient({ api, db, prices, gate, leadTokenBudget, backoff: { sleep: () => Promise.resolve() } });

  it("logs tokens (including cache read/write split), call type, lead, and computed cost", async () => {
    create.mockResolvedValue(
      fakeMessage({
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 300,
        cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 },
      }),
    );
    const { costUsd } = await client().call({ callType: "extract", leadId: "L1" }, params());
    const expected = (1000 * 1 + 200 * 5 + 500 * 0.1 + 300 * 1.25) / 1_000_000;
    expect(costUsd).toBeCloseTo(expected, 12);

    const rows = db.select().from(runs).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "test-model",
      callType: "extract",
      leadId: "L1",
      status: "ok",
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 300,
      cacheWrite5mTokens: 300,
      cacheWrite1hTokens: 0,
      stopReason: "end_turn",
      messageId: "msg_test",
    });
    expect(rows[0]!.costUsd).toBeCloseTo(expected, 12);
  });

  it("counts input tokens with the API (same params, no max_tokens) before calling", async () => {
    create.mockResolvedValue(fakeMessage({ input_tokens: 10, output_tokens: 1 }));
    const tools: Anthropic.Tool[] = [{ name: "t", input_schema: { type: "object", properties: {} } }];
    await client().call({ callType: "extract" }, { ...params(), system: "sys", tools });
    expect(countTokens).toHaveBeenCalledTimes(1);
    const sent = countTokens.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({ model: "test-model", system: "sys", tools });
    expect(sent).not.toHaveProperty("max_tokens");
    expect(countTokens.mock.invocationCallOrder[0]!).toBeLessThan(create.mock.invocationCallOrder[0]!);
  });

  describe("reservation is released and reconciled to actual cost", () => {
    it("on success: reserved goes back to 0 and month spend equals the actual (not worst-case) cost", async () => {
      countTokens.mockResolvedValue({ input_tokens: 2000 });
      let reservedDuringCall = 0;
      create.mockImplementation(async () => {
        reservedDuringCall = gate.reservedUsd();
        return fakeMessage({ input_tokens: 2000, output_tokens: 10 });
      });
      const { costUsd } = await client().call({ callType: "extract" }, params(1000));
      // Worst case: 2000 * $2 (1h write rate) + 1000 * $5 = 9000 per MTok.
      expect(reservedDuringCall).toBeCloseTo(9000 / 1_000_000, 12);
      expect(costUsd).toBeCloseTo((2000 * 1 + 10 * 5) / 1_000_000, 12);
      expect(gate.reservedUsd()).toBe(0);
      expect(gate.spentThisMonthUsd()).toBeCloseTo(costUsd, 12);
    });

    it("on an API error: logged at zero cost, reservation released, error rethrown", async () => {
      create.mockRejectedValue(apiError(400));
      await expect(client().call({ callType: "judge", leadId: "L2" }, params())).rejects.toMatchObject({
        status: 400,
      });
      const rows = db.select().from(runs).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "error", costUsd: 0, leadId: "L2", callType: "judge" });
      expect(rows[0]!.error).toContain("400");
      expect(gate.reservedUsd()).toBe(0);
      expect(gate.spentThisMonthUsd()).toBe(0);
    });

    it("on a timeout: logged at zero cost, reservation released, error rethrown", async () => {
      create.mockRejectedValue(new Anthropic.APIConnectionTimeoutError());
      await expect(client().call({ callType: "write" }, params())).rejects.toBeInstanceOf(
        Anthropic.APIConnectionTimeoutError,
      );
      const rows = db.select().from(runs).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "error", costUsd: 0 });
      expect(rows[0]!.error).toMatch(/timed out|Timeout/i);
      expect(gate.reservedUsd()).toBe(0);
    });

    it("on retries: one reservation held across 429s, one row logged, then released", async () => {
      create
        .mockRejectedValueOnce(apiError(429))
        .mockRejectedValueOnce(apiError(529))
        .mockResolvedValue(fakeMessage({ input_tokens: 10, output_tokens: 1 }));
      await client().call({ callType: "extract" }, params());
      expect(create).toHaveBeenCalledTimes(3);
      expect(db.select().from(runs).all()).toHaveLength(1);
      expect(gate.reservedUsd()).toBe(0);
    });

    it("when concurrent calls overlap, each releases only its own reservation", async () => {
      let resolveFirst!: (m: Anthropic.Message) => void;
      create
        .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
        .mockResolvedValueOnce(fakeMessage({ input_tokens: 5, output_tokens: 1 }));
      const c = client();
      const first = c.call({ callType: "extract" }, params());
      await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const heldByFirst = gate.reservedUsd();
      expect(heldByFirst).toBeGreaterThan(0);
      await c.call({ callType: "extract" }, params());
      expect(gate.reservedUsd()).toBeCloseTo(heldByFirst, 12);
      resolveFirst(fakeMessage({ input_tokens: 5, output_tokens: 1 }));
      await first;
      expect(gate.reservedUsd()).toBe(0);
    });
  });

  it("refuses before calling the API when the worst case would exceed the cap", async () => {
    // max_tokens 300k at $5/MTok = $1.50 of output alone, over the $1 cap.
    await expect(client().call({ callType: "write" }, params(300_000))).rejects.toBeInstanceOf(SpendCapError);
    expect(create).not.toHaveBeenCalled();
    expect(gate.reservedUsd()).toBe(0);
  });

  it("stops calling once logged spend reaches the cap", async () => {
    db.insert(runs).values({ model: "test-model", callType: "extract", status: "ok", costUsd: 1 }).run();
    await expect(client().call({ callType: "extract" }, params())).rejects.toBeInstanceOf(SpendCapError);
    expect(create).not.toHaveBeenCalled();
  });

  describe("per-lead token budget (API usage numbers only)", () => {
    it("counts every usage category, including cache tokens", async () => {
      create.mockResolvedValue(
        fakeMessage({ input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 }),
      );
      await client().call({ callType: "extract", leadId: "L3" }, params());
      expect(leadTokensUsed(db, "L3")).toBe(1175);
    });

    it("refuses when used + counted input (tools included) + max_tokens would exceed the budget", async () => {
      create.mockResolvedValue(fakeMessage({ input_tokens: 600, output_tokens: 200 }));
      const c = client(1000);
      countTokens.mockResolvedValue({ input_tokens: 600 });
      await c.call({ callType: "extract", leadId: "L4" }, params(200)); // 0 + 600 + 200 = 800 <= 1000
      countTokens.mockResolvedValue({ input_tokens: 100 });
      await expect(c.call({ callType: "write", leadId: "L4" }, params(150))).rejects.toBeInstanceOf(
        BudgetExceededError,
      ); // 800 + 100 + 150 = 1050 > 1000
      expect(create).toHaveBeenCalledTimes(1);
      await expect(c.call({ callType: "extract", leadId: "L5" }, params(150))).resolves.toBeDefined();
    });
  });

  it("rejects a model with no price before counting or reserving", async () => {
    await expect(client().call({ callType: "smoke" }, { ...params(), model: "unpriced-model" })).rejects.toThrow(
      /No price/,
    );
    expect(countTokens).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("records a prefix key only for calls that request caching", async () => {
    create.mockResolvedValue(fakeMessage({ input_tokens: 10, output_tokens: 1 }));
    const c = client();
    await c.call({ callType: "extract" }, params());
    const cached: Anthropic.MessageCreateParamsNonStreaming = {
      ...params(),
      system: [{ type: "text", text: "static rules", cache_control: { type: "ephemeral" } }],
    };
    await c.call({ callType: "extract" }, cached);
    const [plain, withCache] = db.select().from(runs).all();
    expect(plain!.prefixKey).toBeNull();
    expect(withCache!.prefixKey).toBe(prefixKey(cached));
    // Same static prefix, different per-lead messages -> same key.
    expect(prefixKey({ ...cached, messages: [{ role: "user", content: "other lead" }] })).toBe(prefixKey(cached));
  });
});
