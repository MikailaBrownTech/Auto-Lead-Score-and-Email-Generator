import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { supabase, type Session } from "./lib/supabase";

interface AuthState {
  /** undefined while the initial session check is still running. */
  session: Session | null | undefined;
}

const AuthContext = createContext<AuthState>({ session: undefined });

/** Tracks the Supabase session: the initial check, plus sign-in/sign-out/refresh as they happen. */
export function AuthProvider(props: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setSession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={{ session }}>{props.children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
