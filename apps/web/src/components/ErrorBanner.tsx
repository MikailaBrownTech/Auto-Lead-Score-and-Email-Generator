import type { ReactNode } from "react";

/** An inline, always-visible error. Failed requests are never swallowed: they land here. */
export function ErrorBanner(props: { message: string | null | undefined; onDismiss?: () => void }) {
  if (!props.message) return null;
  return (
    <div className="banner-error" role="alert">
      <span>{props.message}</span>
      {props.onDismiss && (
        <button type="button" className="link" onClick={props.onDismiss} aria-label="Dismiss">
          dismiss
        </button>
      )}
    </div>
  );
}

/** A plain-language explanation (not an error): why something did not happen, and what to do. */
export function NoticeBanner(props: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div className={`banner-notice ${props.tone ?? "warn"}`} role="status">
      {props.children}
    </div>
  );
}
