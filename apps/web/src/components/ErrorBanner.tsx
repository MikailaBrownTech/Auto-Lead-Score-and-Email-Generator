import type { ReactNode } from "react";
import { Icon } from "./ui";

/** An inline, always-visible error. Failed requests are never swallowed: they land here. */
export function ErrorBanner(props: { message: string | null | undefined; onDismiss?: () => void }) {
  if (!props.message) return null;
  return (
    <div className="banner error" role="alert">
      <Icon name="error" />
      <span className="banner-body">{props.message}</span>
      {props.onDismiss && (
        <button type="button" className="link-button dismiss" onClick={props.onDismiss} aria-label="Dismiss">
          dismiss
        </button>
      )}
    </div>
  );
}

/** A plain-language explanation (not an error): why something did not happen, and what to do. */
export function NoticeBanner(props: { children: ReactNode; tone?: "info" | "warn" | "success" }) {
  const tone = props.tone === "info" ? "info" : props.tone === "success" ? "success" : "warning";
  return (
    <div className={`banner ${tone}`} role="status">
      <Icon name={tone === "info" ? "info" : tone === "success" ? "check" : "alert"} />
      <div className="banner-body">{props.children}</div>
    </div>
  );
}
