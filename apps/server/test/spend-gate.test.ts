import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { SpendCapError, SpendGate } from "../src/llm/spend-gate";

const NOW = new Date("2026-09-15T12:00:00.000Z");

function logRun(db: Db, costUsd: number, createdAt: string) {
  db.insert(runs).values({ model: "m", callType: "smoke", status: "ok", costUsd, createdAt }).run();
}

describe("SpendGate", () => {
  let db: Db;
  let gate: SpendGate;

  beforeEach(() => {
    db = openDb(":memory:");
    gate = new SpendGate(db, 5, () => NOW);
  });

  it("sums only this UTC month's runs", () => {
    logRun(db, 1.5, "2026-09-01T00:00:00.000Z");
    logRun(db, 0.25, "2026-09-30T23:59:59.999Z");
    logRun(db, 100, "2026-08-31T23:59:59.999Z");
    logRun(db, 100, "2026-10-01T00:00:00.000Z");
    expect(gate.spentThisMonthUsd()).toBeCloseTo(1.75, 10);
    expect(gate.currentMonth()).toBe("2026-09");
  });

  it("allows a reservation that fits and refuses one that would exceed the cap", () => {
    logRun(db, 4, "2026-09-10T00:00:00.000Z");
    const r = gate.reserve(0.9);
    expect(gate.reservedUsd()).toBeCloseTo(0.9, 10);
    expect(() => gate.reserve(0.2)).toThrowError(SpendCapError);
    r.release();
    expect(gate.reservedUsd()).toBe(0);
    expect(() => gate.reserve(0.2)).not.toThrow();
  });

  it("counts concurrent open reservations against the cap", () => {
    const a = gate.reserve(2);
    const b = gate.reserve(2);
    expect(() => gate.reserve(1.01)).toThrowError(SpendCapError);
    a.release();
    b.release();
  });

  it("allows spending exactly up to the cap", () => {
    logRun(db, 4, "2026-09-10T00:00:00.000Z");
    expect(() => gate.reserve(1)).not.toThrow();
  });

  it("release is idempotent", () => {
    const a = gate.reserve(1);
    const b = gate.reserve(1);
    a.release();
    a.release();
    expect(gate.reservedUsd()).toBeCloseTo(1, 10);
    b.release();
  });
});
