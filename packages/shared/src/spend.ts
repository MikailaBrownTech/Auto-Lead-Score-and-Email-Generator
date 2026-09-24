import { z } from "zod";

/** Response shape of GET /api/spend, shared by server and web. */
export const SpendSummarySchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  capUsd: z.number().positive(),
});
export type SpendSummary = z.infer<typeof SpendSummarySchema>;

/** A cacheable static prefix whose recent calls all got zero cache reads (GET /api/cache-health). */
export const CacheWarningSchema = z.object({
  prefixKey: z.string(),
  model: z.string(),
  callType: z.string(),
  recentCalls: z.number().int(),
  lastCallAt: z.string(),
});
export type CacheWarning = z.infer<typeof CacheWarningSchema>;

/** warnings: shown as a banner. belowMinimum: prefix too short for the model to cache (informational). */
export const CacheHealthSchema = z.object({
  warnings: z.array(CacheWarningSchema),
  belowMinimum: z.array(CacheWarningSchema),
});
export type CacheHealth = z.infer<typeof CacheHealthSchema>;
