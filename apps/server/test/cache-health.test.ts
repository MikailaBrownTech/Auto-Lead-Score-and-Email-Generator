import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { cacheWarnings } from "../src/llm/cache-health";

function log(db: Db, prefixKey: string | null, cacheReadTokens: number, status: "ok" | "error" = "ok") {
  db.insert(runs)
    .values({ model: "claude-haiku-4-5", callType: "extract", status, prefixKey, cacheReadTokens })
    .run();
}

describe("cacheWarnings", () => {
  let db: Db;
  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("warns when the last 5 calls for a prefix all had zero cache reads", () => {
    for (let i = 0; i < 5; i++) log(db, "p1", 0);
    const w = cacheWarnings(db);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ prefixKey: "p1", model: "claude-haiku-4-5", callType: "extract", recentCalls: 5 });
  });

  it("does not warn with fewer than 5 calls", () => {
    for (let i = 0; i < 4; i++) log(db, "p1", 0);
    expect(cacheWarnings(db)).toEqual([]);
  });

  it("does not warn when any recent call read from cache", () => {
    log(db, "p1", 0);
    for (let i = 0; i < 4; i++) log(db, "p1", 3000);
    expect(cacheWarnings(db)).toEqual([]);
  });

  it("warns on a regression: reads earlier, then 5 misses in a row", () => {
    for (let i = 0; i < 3; i++) log(db, "p1", 3000);
    for (let i = 0; i < 5; i++) log(db, "p1", 0);
    expect(cacheWarnings(db)).toHaveLength(1);
  });

  it("ignores calls that did not request caching and failed calls", () => {
    for (let i = 0; i < 6; i++) log(db, null, 0);
    for (let i = 0; i < 6; i++) log(db, "p2", 0, "error");
    expect(cacheWarnings(db)).toEqual([]);
  });

  it("tracks prefixes independently", () => {
    for (let i = 0; i < 5; i++) log(db, "bad", 0);
    for (let i = 0; i < 5; i++) log(db, "good", 2000);
    expect(cacheWarnings(db).map((w) => w.prefixKey)).toEqual(["bad"]);
  });
});
