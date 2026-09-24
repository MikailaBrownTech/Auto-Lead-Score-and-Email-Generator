import { describe, expect, it } from "vitest";
import { fromRoot } from "../src/config/paths";
import { assertPricesFor, loadPriceTable, priceFor, PriceError } from "../src/config/prices";

describe("price table (config/prices.json)", () => {
  const table = loadPriceTable(fromRoot("config/prices.json"));

  it("records its source and the date it was checked", () => {
    expect(table.source_url).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(table.checked_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has consistent cache multipliers for every model (5m = 1.25x, 1h = 2x input)", () => {
    for (const [model, p] of Object.entries(table.models)) {
      expect(p.cache_write_5m, model).toBeCloseTo(p.input * 1.25, 10);
      expect(p.cache_write_1h, model).toBeCloseTo(p.input * 2, 10);
      expect(p.cache_read, model).toBeLessThan(p.input);
    }
  });

  it("records which tokenizer each model uses, with its source", () => {
    expect(priceFor(table, "claude-sonnet-5").tokenizer).toBe("newer");
    expect(priceFor(table, "claude-haiku-4-5").tokenizer).toBe("previous");
    expect(table.tokenizer_note.source_url).toMatch(/^https:\/\/platform\.claude\.com\//);
    expect(table.tokenizer_note.checked_on).toBe("2026-09-23");
  });

  it("resolves the dated Haiku snapshot ID through its alias", () => {
    expect(priceFor(table, "claude-haiku-4-5-20251001")).toEqual(priceFor(table, "claude-haiku-4-5"));
  });

  it("fails fast for a model with no price", () => {
    expect(() => assertPricesFor(table, ["claude-haiku-4-5", "claude-made-up-9"])).toThrowError(PriceError);
  });
});
