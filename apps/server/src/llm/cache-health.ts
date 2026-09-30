import type { CacheHealth, CacheWarning } from "@clearpath/shared";
import type { RunsDb } from "../db/supa-runs";

/** How many recent successful calls per prefix are examined. */
export const CACHE_WARNING_MIN_CALLS = 5;

/**
 * Classifies each cacheable static prefix by its most recent calls:
 *  - warning: zero cache reads, but the API did write the prefix to cache. The prefix is long enough
 *    to cache, yet nothing is reused: something volatile is inside it, or calls are more than
 *    5 minutes apart. This shows as a banner.
 *  - below minimum: zero reads and zero writes. The API skips caching entirely when a prefix is
 *    shorter than the model's minimum (4096 tokens on Haiku 4.5), so zero reads are expected. Listed
 *    for information only; no banner, and prompts are never padded to force caching.
 */
export async function cacheHealth(runsDb: RunsDb, minCalls = CACHE_WARNING_MIN_CALLS): Promise<CacheHealth> {
  // Already newest-first; grouping by prefixKey here keeps each group's own recency order.
  const rows = await runsDb.listOkWithPrefixKey();
  const byPrefix = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.prefixKey) continue;
    const list = byPrefix.get(r.prefixKey) ?? [];
    list.push(r);
    byPrefix.set(r.prefixKey, list);
  }

  const warnings: CacheWarning[] = [];
  const belowMinimum: CacheWarning[] = [];
  for (const [prefixKey, all] of byPrefix) {
    const recent = all.slice(0, minCalls);
    if (recent.length < minCalls || recent.some((r) => r.cacheReadTokens > 0)) continue;
    const latest = recent[0]!;
    const entry: CacheWarning = {
      prefixKey,
      model: latest.model,
      callType: latest.callType,
      recentCalls: recent.length,
      lastCallAt: latest.createdAt,
    };
    if (recent.some((r) => r.cacheWriteTokens > 0)) warnings.push(entry);
    else belowMinimum.push(entry);
  }
  return { warnings, belowMinimum };
}

/** Banner-worthy warnings only. */
export async function cacheWarnings(runsDb: RunsDb, minCalls = CACHE_WARNING_MIN_CALLS): Promise<CacheWarning[]> {
  return (await cacheHealth(runsDb, minCalls)).warnings;
}
