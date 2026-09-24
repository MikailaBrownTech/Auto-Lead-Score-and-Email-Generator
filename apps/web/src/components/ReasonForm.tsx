import { useState } from "react";

export const MIN_REASON = 10;

/**
 * A manual decision that needs a typed reason (kept in the lead's log). The button stays disabled
 * until the reason is long enough.
 */
export function ReasonForm(props: { label: string; button: string; onSubmit: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= MIN_REASON;
  return (
    <form
      className="reason-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ok) return;
        setBusy(true);
        setError(null);
        try {
          await props.onSubmit(reason.trim());
          setReason("");
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        {props.label}
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder="Why? This is saved in the lead's log." />
      </label>
      <div className="row">
        <button type="submit" disabled={!ok || busy}>
          {busy ? "Saving…" : props.button}
        </button>
        {!ok && <span className="muted">Type a reason of at least {MIN_REASON} characters.</span>}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
