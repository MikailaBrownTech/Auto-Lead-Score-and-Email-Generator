import type { MiddlewareHandler } from "hono";
import type { AuthedUser } from "./supabase";

const BEARER_RE = /^Bearer (.+)$/;

/** Verifies one bearer token against Supabase, or returns null. Injected so tests never need a live Supabase project. */
export type VerifyToken = (accessToken: string) => Promise<AuthedUser | null>;

/**
 * Requires a valid Supabase session on every /api/* request (runs after local-guard's origin/token
 * check). The browser calls supabase.auth.signInWithPassword/signUp/signOut directly against
 * Supabase and sends the resulting access token as a bearer header on every API call; there is no
 * /api/auth/login route here, since the API never holds a session of its own to authenticate against
 * (there is no cookie/middleware layer in this app -- it is a Vite SPA + a separate API, not Next.js).
 * The token is re-validated against Supabase on every request (auth.getUser, via `verify`), the same
 * guarantee the companion app's middleware gets from never trusting a cookie alone.
 */
export function authGuard(verify: VerifyToken): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const token = BEARER_RE.exec(header)?.[1] ?? "";
    const user = token ? await verify(token) : null;
    // A distinct code from local-guard's "unauthorized" (wrong place) so the client can tell "no
    // session, sign in" apart from "wrong process token, restart the app".
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    c.set("user", user);
    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthedUser;
  }
}
