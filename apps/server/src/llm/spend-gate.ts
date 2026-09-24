import { and, gte, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { runs } from "../db/schema";

export class SpendCapError extends Error {
  override name = "SpendCapError";
}

export interface Reservation {
  readonly amountUsd: number;
  release(): void;
}

/** Calendar month in UTC, e.g. "2026-09". */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function monthBounds(d: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Enforces the monthly spend cap. Before each call a worst-case cost is reserved; the call only
 * proceeds if logged spend this month + all open reservations + this reservation stays within the cap.
 * better-sqlite3 is synchronous, so check-and-reserve cannot interleave with another reservation.
 */
export class SpendGate {
  private reserved = 0;

  constructor(
    private readonly db: Db,
    readonly capUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  currentMonth(): string {
    return monthKey(this.now());
  }

  spentThisMonthUsd(): number {
    const { start, end } = monthBounds(this.now());
    const row = this.db
      .select({ total: sql<number>`coalesce(sum(${runs.costUsd}), 0)` })
      .from(runs)
      .where(and(gte(runs.createdAt, start), lt(runs.createdAt, end)))
      .get();
    return row?.total ?? 0;
  }

  reservedUsd(): number {
    return this.reserved;
  }

  reserve(amountUsd: number): Reservation {
    const spent = this.spentThisMonthUsd();
    if (spent + this.reserved + amountUsd > this.capUsd) {
      throw new SpendCapError(
        `Monthly spend cap reached: $${spent.toFixed(4)} spent + $${this.reserved.toFixed(4)} reserved + ` +
          `$${amountUsd.toFixed(4)} worst case for this call would exceed the $${this.capUsd.toFixed(2)} cap. ` +
          `No API call was made.`,
      );
    }
    this.reserved += amountUsd;
    let released = false;
    return {
      amountUsd,
      release: () => {
        if (released) return;
        released = true;
        this.reserved = Math.max(0, this.reserved - amountUsd);
      },
    };
  }
}
