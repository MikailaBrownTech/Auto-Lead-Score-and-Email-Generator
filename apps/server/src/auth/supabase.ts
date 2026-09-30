import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Env } from "../config/env";

/**
 * Bypasses RLS entirely. Only for the migration script and other privileged, one-off server-side
 * operations with no signed-in user to scope to. Never used to answer a user's own API request --
 * see auth/guard.ts, which verifies that request's own token and lets normal RLS apply.
 */
export function createServiceRoleClient(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY">): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** A client scoped to one request's own bearer token (RLS applies as that user). */
export function createRequestClient(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">, accessToken: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface AuthedUser {
  id: string;
  email: string | null;
}

/**
 * Verifies a bearer token against Supabase (not just decoding it -- an expired or revoked session is
 * caught every time, the same guarantee the companion app's middleware gets from re-validating on
 * every request). Returns null for a missing, malformed, or invalid token.
 */
export async function verifyAccessToken(env: Pick<Env, "SUPABASE_URL" | "SUPABASE_ANON_KEY">, accessToken: string): Promise<AuthedUser | null> {
  if (!accessToken) return null;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await supabase.auth.getUser(accessToken);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email ?? null };
}
