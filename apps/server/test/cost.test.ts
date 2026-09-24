import { describe, expect, it } from "vitest";
import type { ModelPrice } from "../src/config/prices";
import { computeCostUsd, worstCaseCostUsd } from "../src/llm/cost";

const haiku: ModelPrice = {
  input: 1,
  cache_write_5m: 1.25,
  cache_write_1h: 2,
  cache_read: 0.1,
  output: 5,
  tokenizer: "previous",
};

describe("computeCostUsd", () => {
  it("prices plain input and output per million tokens", () => {
    expect(computeCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }, haiku)).toBeCloseTo(1, 10);
    expect(computeCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }, haiku)).toBeCloseTo(5, 10);
    expect(computeCostUsd({ input_tokens: 1000, output_tokens: 200 }, haiku)).toBeCloseTo(0.002, 10);
  });

  it("bills cache reads and 5m/1h writes at their own rates", () => {
    const cost = computeCostUsd(
      {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
      },
      haiku,
    );
    // 100*1 + 50*5 + 10000*0.1 + 2000*1.25 + 1000*2 = 100 + 250 + 1000 + 2500 + 2000 = 5850 per MTok
    expect(cost).toBeCloseTo(5850 / 1_000_000, 12);
  });

  it("bills cache writes at the 1h rate when the TTL breakdown is missing (never undercounts)", () => {
    const cost = computeCostUsd({ input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000 }, haiku);
    expect(cost).toBeCloseTo((1000 * 2) / 1_000_000, 12);
  });

  it("treats null cache fields as zero", () => {
    expect(
      computeCostUsd(
        { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null },
        haiku,
      ),
    ).toBeCloseTo(15 / 1_000_000, 12);
  });
});

describe("worst-case reservation", () => {
  it("prices every input token at the highest input rate plus full max_tokens of output", () => {
    expect(worstCaseCostUsd(1000, 100, haiku)).toBeCloseTo((1000 * 2 + 100 * 5) / 1_000_000, 12);
  });

  it("is never below the actual cost of the same call", () => {
    const actual = computeCostUsd(
      { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 300, cache_creation_input_tokens: 300 },
      haiku,
    );
    expect(worstCaseCostUsd(1000, 100, haiku)).toBeGreaterThanOrEqual(actual);
  });
});
