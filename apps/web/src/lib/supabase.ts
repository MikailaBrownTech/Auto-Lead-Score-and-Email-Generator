import { createClient, type Session } from "@supabase/supabase-js";

// Vite only exposes vars prefixed VITE_ to the browser bundle; see apps/web/.env.example.
// Same Supabase project as the root .env's SUPABASE_URL (and the companion clearpath-
// proposal-generator app) -- a new project is never created for this app.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    "VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are not set. Copy apps/web/.env.example to apps/web/.env.local and fill them in (Project Settings -> API in the Supabase dashboard), then restart `npm run dev:web`.",
  );
}

/** Session kept in the browser (localStorage); no cookies or server middleware involved. */
export const supabase = createClient(url, anonKey);

export async function signIn(email: string, password: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error: error?.message ?? null };
}

export async function signUp(email: string, password: string, fullName: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
  return { error: error?.message ?? null };
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

/** For the api() helper: attaches this as the Authorization bearer on every request. Null when signed out. */
export async function currentAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export type { Session };
