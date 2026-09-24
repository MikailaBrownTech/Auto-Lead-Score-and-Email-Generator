import { and, desc, eq, isNotNull } from "drizzle-orm";
import type { CacheWarning } from "@clearpath/shared";
import type { Db } from "../db/client";
import { runs } from "../db/schema";

/** A cacheable prefix is flagged when its most recent `minCalls` successful calls all had zero cache reads. */
export const CACHE_WARNING_MIN_CALLS = 5;

/**
 * Finds static prefixes that are not caching. Common causes: the prefix is shorter than the
 * model's minimum cacheable length (4096 tokens on Haiku 4.5), something volatile sits inside it,
 * or calls are more than 5 minutes apart (the default cache lifetime).
 */
export function cacheWarnings(db: Db, minCalls = CACHE_WARNING_MIN_CALLS): CacheWarning[] {
  const keys = db
    .selectDistinct({ prefixKey: runs.prefixKey })
    .from(runs)
    .where(and(isNotNull(runs.prefixKey), eq(runs.status, "ok")))
    .all();

  const warnings: CacheWarning[] = [];
  for (const { prefixKey } of keys) {
    if (!prefixKey) continue;
    const recent = db
      .select()
      .from(runs)
      .where(and(eq(runs.prefixKey, prefixKey), eq(runs.status, "ok")))
      .orderBy(desc(runs.id))
      .limit(minCalls)
      .all();
    if (recent.length < minCalls) continue;
    if (recent.every((r) => r.cacheReadTokens === 0)) {
      const latest = recent[0]!;
      warnings.push({
        prefixKey,
        model: latest.model,
        callType: latest.callType,
        recentCalls: recent.length,
        lastCallAt: latest.createdAt,
      });
    }
  }
  return warnings;
}
