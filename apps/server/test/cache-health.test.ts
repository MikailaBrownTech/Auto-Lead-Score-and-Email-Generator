import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { cacheHealth, cacheWarnings } from "../src/llm/cache-health";

function log(
  db: Db,
  prefixKey: string | null,
  cacheReadTokens: number,
  cacheWriteTokens = 0,
  status: "ok" | "error" = "ok",
) {
  db.insert(runs)
    .values({ model: "claude-haiku-4-5", callType: "extract", status, prefixKey, cacheReadTokens, cacheWriteTokens })
    .run();
}

describe("cache health", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("warns when a cacheable prefix (writes happen) gets zero reads over the last 5 calls", () => {
    for (let i = 0; i < 5; i++) log(db, "p1", 0, 5000);
    const w = cacheWarnings(db);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ prefixKey: "p1", model: "claude-haiku-4-5", callType: "extract", recentCalls: 5 });
  });

  it("does not warn when the prefix is below the model's cacheable minimum (no reads and no writes)", () => {
    // Haiku 4.5 needs 4096 tokens; a shorter extraction prefix is never written, so zero reads are expected.
    for (let i = 0; i < 8; i++) log(db, "short", 0, 0);
    const h = cacheHealth(db);
    expect(h.warnings).toEqual([]);
    expect(h.belowMinimum.map((x) => x.prefixKey)).toEqual(["short"]);
  });

  it("does not warn with fewer than 5 calls", () => {
    for (let i = 0; i < 4; i++) log(db, "p1", 0, 5000);
    expect(cacheWarnings(db)).toEqual([]);
  });

  it("does not warn when any recent call read from cache", () => {
    log(db, "p1", 0, 5000);
    for (let i = 0; i < 4; i++) log(db, "p1", 5000);
    expect(cacheHealth(db)).toEqual({ warnings: [], belowMinimum: [] });
  });

  it("warns on a regression: reads earlier, then 5 misses in a row with writes", () => {
    for (let i = 0; i < 3; i++) log(db, "p1", 5000);
    for (let i = 0; i < 5; i++) log(db, "p1", 0, 5000);
    expect(cacheWarnings(db)).toHaveLength(1);
  });

  it("ignores calls that did not request caching and failed calls", () => {
    for (let i = 0; i < 6; i++) log(db, null, 0, 5000);
    for (let i = 0; i < 6; i++) log(db, "p2", 0, 5000, "error");
    expect(cacheHealth(db)).toEqual({ warnings: [], belowMinimum: [] });
  });

  it("tracks prefixes independently", () => {
    for (let i = 0; i < 5; i++) log(db, "bad", 0, 5000);
    for (let i = 0; i < 5; i++) log(db, "good", 5000);
    expect(cacheWarnings(db).map((w) => w.prefixKey)).toEqual(["bad"]);
  });
});
