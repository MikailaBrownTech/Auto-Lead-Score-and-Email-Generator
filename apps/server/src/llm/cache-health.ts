import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { CacheHealth, CacheWarning } from "@clearpath/shared";
import type { Db } from "../db/client";
import { runs } from "../db/schema";

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
export function cacheHealth(db: Db, minCalls = CACHE_WARNING_MIN_CALLS): CacheHealth {
  const keys = db
    .selectDistinct({ prefixKey: runs.prefixKey })
    .from(runs)
    .where(and(isNotNull(runs.prefixKey), eq(runs.status, "ok")))
    .all();

  const warnings: CacheWarning[] = [];
  const belowMinimum: CacheWarning[] = [];
  for (const { prefixKey } of keys) {
    if (!prefixKey) continue;
    const recent = db
      .select()
      .from(runs)
      .where(and(eq(runs.prefixKey, prefixKey), eq(runs.status, "ok")))
      .orderBy(desc(runs.id))
      .limit(minCalls)
      .all();
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
export function cacheWarnings(db: Db, minCalls = CACHE_WARNING_MIN_CALLS): CacheWarning[] {
  return cacheHealth(db, minCalls).warnings;
}
