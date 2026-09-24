import fs from "node:fs";
import { z } from "zod";

const usdPerMTok = z.number().nonnegative();

export const ModelPriceSchema = z.object({
  input: usdPerMTok,
  cache_write_5m: usdPerMTok,
  cache_write_1h: usdPerMTok,
  cache_read: usdPerMTok,
  output: usdPerMTok,
  /** "newer" = Claude 4.7+ tokenizer (~30% more tokens for the same text), per the pricing page. */
  tokenizer: z.enum(["newer", "previous"]),
});
export type ModelPrice = z.infer<typeof ModelPriceSchema>;

export const PriceTableSchema = z.object({
  source_url: z.string().url(),
  checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  currency: z.literal("USD"),
  unit: z.literal("per_million_tokens"),
  notes: z.array(z.string()).default([]),
  tokenizer_note: z.object({
    text: z.string().min(1),
    source_url: z.string().url(),
    checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD"),
  }),
  models: z.record(ModelPriceSchema),
  /** Dated snapshot IDs that bill at the same rate as a listed model, e.g. "claude-haiku-4-5-20251001" -> "claude-haiku-4-5". */
  aliases: z.record(z.string()).default({}),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

export class PriceError extends Error {
  override name = "PriceError";
}

export function loadPriceTable(filePath: string): PriceTable {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new PriceError(`Could not read price table at ${filePath}: ${(err as Error).message}`);
  }
  const parsed = PriceTableSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new PriceError(`Price table ${filePath} is invalid:\n${lines.join("\n")}`);
  }
  for (const [alias, target] of Object.entries(parsed.data.aliases)) {
    if (!parsed.data.models[target]) {
      throw new PriceError(`Price table alias ${alias} points to ${target}, which has no price entry.`);
    }
  }
  return parsed.data;
}

export function priceFor(table: PriceTable, model: string): ModelPrice {
  const key = table.models[model] ? model : table.aliases[model];
  const price = key ? table.models[key] : undefined;
  if (!price) {
    throw new PriceError(
      `No price for model "${model}" in the price table. Add it from ${table.source_url} before using this model.`,
    );
  }
  return price;
}

/** Fail fast at startup if any configured model has no price (cost could not be computed or capped). */
export function assertPricesFor(table: PriceTable, models: string[]): void {
  for (const m of models) priceFor(table, m);
}
