/**
 * Politeness limiter: requests to the same host start at least `intervalMs` apart (1 per second by
 * default; longer when robots.txt sets a Crawl-delay). Slots are reserved synchronously, so
 * concurrent callers queue in order rather than racing.
 */
export class HostRateLimiter {
  private readonly nextAt = new Map<string, number>();
  private readonly intervals = new Map<string, number>();

  constructor(
    private readonly defaultIntervalMs = 1000,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** Raise (never lower) the interval for one host, e.g. from robots.txt Crawl-delay. */
  setInterval(host: string, ms: number): void {
    const key = host.toLowerCase();
    this.intervals.set(key, Math.max(ms, this.defaultIntervalMs, this.intervals.get(key) ?? 0));
  }

  intervalFor(host: string): number {
    return this.intervals.get(host.toLowerCase()) ?? this.defaultIntervalMs;
  }

  async acquire(host: string): Promise<void> {
    const key = host.toLowerCase();
    const now = this.now();
    const start = Math.max(now, this.nextAt.get(key) ?? 0);
    this.nextAt.set(key, start + this.intervalFor(key));
    if (start > now) await this.sleep(start - now);
  }
}
