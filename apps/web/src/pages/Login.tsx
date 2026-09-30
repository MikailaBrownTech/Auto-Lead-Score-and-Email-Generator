import { useState } from "react";
import { signIn, signUp } from "../lib/supabase";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";

/**
 * Same calls as the companion clearpath-proposal-generator app (supabase.auth.signInWithPassword /
 * signUp), just called from the browser directly instead of a Next.js Server Action -- this app has
 * no server-side session layer to act through. The first account to sign up becomes the owner
 * (handle_new_user, in the shared Supabase project); everyone after starts as staff.
 */
export function LoginPage() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const result = mode === "login" ? await signIn(email, password) : await signUp(email, password, fullName);
    if (result.error) {
      setError(result.error);
    } else if (mode === "signup") {
      setMessage("Check your email to confirm your account, then sign in.");
      setMode("login");
    }
    // A successful sign-in needs no further action here: AuthProvider's onAuthStateChange picks it
    // up and the app shell renders in place of this page.
    setBusy(false);
  }

  return (
    <div className="shell login-shell">
      <div className="login-center">
        <div className="card-glass login-card">
          <div className="brand login-brand">
            <span className="brand-mark" aria-hidden="true">
              CP
            </span>
            <span className="brand-text">
              <strong>ClearPath</strong>
              <span>Lead Console</span>
            </span>
          </div>
          <h1 className="page-title">{mode === "login" ? "Sign in" : "Create an account"}</h1>
          <p className="small muted" style={{ marginTop: 4, marginBottom: 20 }}>
            {mode === "login" ? "ClearPath staff only." : "New ClearPath staff member."}
          </p>

          {message && <NoticeBanner tone="success">{message}</NoticeBanner>}
          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          <form className="stack" onSubmit={(e) => void submit(e)}>
            {mode === "signup" && (
              <label className="field">
                <span className="field-label">Full name</span>
                <input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required />
              </label>
            )}
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={mode === "signup" ? 8 : undefined}
                required
              />
            </label>
            <button type="submit" className="btn primary" disabled={busy} style={{ marginTop: 8 }}>
              {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <p className="small muted" style={{ marginTop: 20, textAlign: "center" }}>
            {mode === "login" ? (
              <>
                New ClearPath staff member?{" "}
                <button type="button" className="link-button" onClick={() => { setMode("signup"); setError(null); }}>
                  Create an account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button type="button" className="link-button" onClick={() => { setMode("login"); setError(null); }}>
                  Sign in
                </button>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}
