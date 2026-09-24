import crypto from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "../db/client";
import { pages, robotsTxt, tokenCounts } from "../db/schema";
import type { RobotsStore } from "../fetch/robots";
import type { PageLink } from "../fetch/clean";
import type { FetchedPage } from "../fetch/site";
import type { LlmClient } from "../llm/client";
import type { CountTokens } from "./token-caps";

export interface PageCache {
  get(requestedUrl: string): { page: FetchedPage; links: PageLink[] } | null;
  put(page: FetchedPage, links: PageLink[]): void;
}

/**
 * SQLite page cache. A page fetched within `ttlDays` is reused instead of re-fetched (no request,
 * no robots.txt check). Rows are keyed by URL and the raw-body hash, so identical re-fetches are not
 * duplicated.
 */
export function createPageCache(db: Db, ttlDays: number, now: () => Date = () => new Date()): PageCache {
  return {
    get(requestedUrl) {
      const since = new Date(now().getTime() - ttlDays * 86_400_000).toISOString();
      const row = db
        .select()
        .from(pages)
        .where(and(eq(pages.requestedUrl, requestedUrl), gte(pages.fetchedAt, since)))
        .orderBy(desc(pages.fetchedAt), desc(pages.id))
        .limit(1)
        .get();
      if (!row) return null;
      return {
        page: {
          requestedUrl: row.requestedUrl,
          url: row.url,
          kind: "other",
          httpStatus: 200,
          contentType: row.contentType,
          title: row.title,
          text: row.text,
          hiddenText: row.hiddenText,
          dates: JSON.parse(row.datesJson) as FetchedPage["dates"],
          textSha256: row.textSha256,
          rawSha256: row.rawSha256,
          bytes: row.bytes,
          truncated: row.truncated,
          nearEmpty: row.nearEmpty,
          fetchedAt: row.fetchedAt,
        },
        links: JSON.parse(row.linksJson) as PageLink[],
      };
    },
    put(page, links) {
      const existing = db
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.url, page.url), eq(pages.rawSha256, page.rawSha256), eq(pages.requestedUrl, page.requestedUrl)))
        .get();
      if (existing) {
        db.update(pages).set({ fetchedAt: page.fetchedAt }).where(eq(pages.id, existing.id)).run();
        return;
      }
      db.insert(pages)
        .values({
          requestedUrl: page.requestedUrl,
          url: page.url,
          contentType: page.contentType,
          title: page.title,
          text: page.text,
          hiddenText: page.hiddenText,
          linksJson: JSON.stringify(links),
          datesJson: JSON.stringify(page.dates),
          textSha256: page.textSha256,
          rawSha256: page.rawSha256,
          bytes: page.bytes,
          truncated: page.truncated,
          nearEmpty: page.nearEmpty,
          fetchedAt: page.fetchedAt,
        })
        .run();
    },
  };
}

/** robots.txt answers reused within the cache window, so reruns make no requests at all. */
export function createRobotsStore(db: Db, ttlDays: number, now: () => Date = () => new Date()): RobotsStore {
  return {
    get(origin) {
      const since = new Date(now().getTime() - ttlDays * 86_400_000).toISOString();
      const row = db.select().from(robotsTxt).where(and(eq(robotsTxt.origin, origin), gte(robotsTxt.fetchedAt, since))).get();
      return row ? { status: row.status, body: row.body } : null;
    },
    put(origin, snapshot) {
      const values = { origin, status: snapshot.status, body: snapshot.body, fetchedAt: now().toISOString() };
      db.insert(robotsTxt).values(values).onConflictDoUpdate({ target: robotsTxt.origin, set: values }).run();
    },
  };
}

/** count_tokens for a model, memoized in SQLite by text hash so unchanged text is never recounted. */
export function createTokenCounter(db: Db, llm: LlmClient, model: string): CountTokens {
  return async (text) => {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    const row = db
      .select({ tokens: tokenCounts.tokens })
      .from(tokenCounts)
      .where(and(eq(tokenCounts.textSha256, hash), eq(tokenCounts.model, model)))
      .get();
    if (row) return row.tokens;
    const tokens = await llm.countText(model, text);
    db.insert(tokenCounts).values({ textSha256: hash, model, tokens }).onConflictDoNothing().run();
    return tokens;
  };
}
