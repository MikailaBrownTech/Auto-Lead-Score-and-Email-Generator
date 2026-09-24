import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";

export const TOKEN_HEADER = "x-clearpath-token";

/** Random per-process token. */
export function newLocalToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Writes the token to a git-ignored file so the Vite dev proxy can attach it. Call only once the port
 * is bound: a second copy that fails to start must not replace the running server's token.
 */
export function writeLocalToken(tokenFile: string, token: string): void {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
}

/** New token, written immediately (tests and tools that do not bind a port). */
export function createLocalToken(tokenFile: string): string {
  const token = newLocalToken();
  writeLocalToken(tokenFile, token);
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export interface LocalGuardOptions {
  port: number;
  token: string;
  /** Extra browser origins allowed to call the API (the Vite dev server). */
  allowedOrigins: string[];
}

/**
 * Rejects anything that is not a local, authenticated request:
 *  - Host must be localhost/127.0.0.1 on our port (blocks DNS-rebinding attacks),
 *  - Origin, when a browser sends one, must be our own origin or an allowed dev origin,
 *  - the per-process token header must match.
 * No CORS headers are ever set, so other sites cannot read responses.
 */
export function localGuard(opts: LocalGuardOptions): MiddlewareHandler {
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  const allowedOrigins = new Set([
    `http://127.0.0.1:${opts.port}`,
    `http://localhost:${opts.port}`,
    ...opts.allowedOrigins,
  ]);

  return async (c, next) => {
    const host = (c.req.header("host") ?? "").toLowerCase();
    if (!allowedHosts.has(host)) {
      return c.json({ error: "forbidden_host" }, 403);
    }
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return c.json({ error: "forbidden_origin" }, 403);
    }
    const supplied = c.req.header(TOKEN_HEADER) ?? "";
    if (!safeEqual(supplied, opts.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}
