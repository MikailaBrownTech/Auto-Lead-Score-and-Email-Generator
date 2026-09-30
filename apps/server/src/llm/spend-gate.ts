import type { RunsDb } from "../db/supa-runs";

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
 *
 * `spentThisMonthUsd` now reads from Supabase over the network, so it's async -- but the check-then-
 * reserve sequence must still never interleave with another one (two concurrent research jobs, from
 * p-queue's QUEUE_CONCURRENCY, could otherwise both read the same "spent so far" during their own
 * await and both pass a check that, combined, blows the cap). `reserve()` chains onto a single
 * in-process promise queue so only one check-then-reserve runs at a time, same guarantee
 * better-sqlite3's synchronous access gave for free before.
 */
export class SpendGate {
  private reserved = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly runsDb: RunsDb,
    readonly capUsd: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  currentMonth(): string {
    return monthKey(this.now());
  }

  async spentThisMonthUsd(): Promise<number> {
    const { start, end } = monthBounds(this.now());
    return this.runsDb.costInRange(start, end);
  }

  reservedUsd(): number {
    return this.reserved;
  }

  /** Serializes check-then-reserve across concurrent callers; see the class comment. */
  reserve(amountUsd: number): Promise<Reservation> {
    const next = this.queue.then(() => this.reserveNow(amountUsd));
    // Advance the queue even on failure (a rejected reservation must not wedge later callers), but
    // never let that internal chain surface an unhandled rejection.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async reserveNow(amountUsd: number): Promise<Reservation> {
    const spent = await this.spentThisMonthUsd();
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
