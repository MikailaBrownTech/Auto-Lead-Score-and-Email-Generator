import type { ReactNode } from "react";

/** Stroke icons (24x24 grid). Decorative: the text next to them always carries the meaning. */
const ICONS = {
  import: (
    <>
      <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
      <polyline points="10 17 15 12 10 7" />
      <line x1="15" y1="12" x2="3" y2="12" />
    </>
  ),
  leads: (
    <>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="22 6 12 13 2 6" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </>
  ),
  settings: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  alert: (
    <>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </>
  ),
  check: (
    <>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </>
  ),
  back: (
    <>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </>
  ),
  external: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </>
  ),
  refresh: (
    <>
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  user: (
    <>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </>
  ),
} as const;

export type IconName = keyof typeof ICONS;

export function Icon(props: { name: IconName; className?: string }) {
  return (
    <svg className={`icon${props.className ? ` ${props.className}` : ""}`} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ICONS[props.name]}
    </svg>
  );
}

export type Tone = "neutral" | "info" | "success" | "warning" | "danger" | "approved";

/** A badge always shows its meaning in words; the tone only supports it. */
export function Badge(props: { tone?: Tone; icon?: IconName; title?: string; mono?: boolean; children: ReactNode }) {
  const tone = props.tone && props.tone !== "neutral" ? ` ${props.tone}` : "";
  return (
    <span className={`badge${tone}${props.mono ? " mono" : ""}`} title={props.title}>
      {props.icon && <Icon name={props.icon} />}
      {props.children}
    </span>
  );
}

export function TierChip(props: { tier: string | null | undefined; large?: boolean }) {
  if (!props.tier) return <span className="muted">—</span>;
  return (
    <span className={`tier tier-${props.tier}${props.large ? " lg" : ""}`} aria-label={`Tier ${props.tier}`} title={`Tier ${props.tier}`}>
      {props.large ? `Tier ${props.tier}` : props.tier}
    </span>
  );
}

/** Lead and sequence statuses in words, with a tone. */
const STATUS_TONE: Record<string, Tone> = {
  extracted: "success",
  qualified: "success",
  passed: "success",
  // The one place --lime appears in this app: Approved status, and nothing else.
  approved: "approved",
  no_named_contact: "warning",
  needs_review: "warning",
  budget_exceeded: "warning",
  outdated_research: "warning",
  blocked: "danger",
  failed: "danger",
  out_of_icp: "neutral",
};

export function StatusBadge(props: { status: string | null | undefined }) {
  if (!props.status) return <span className="muted">—</span>;
  return <Badge tone={STATUS_TONE[props.status] ?? "neutral"}>{props.status.replace(/_/g, " ")}</Badge>;
}

export function EmptyState(props: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={props.icon ?? "info"} />
      <strong>{props.title}</strong>
      {props.children && <p>{props.children}</p>}
      {props.action}
    </div>
  );
}

/** Placeholder bars while a page loads. */
export function Skeleton(props: { lines?: number; title?: boolean }) {
  const widths = ["92%", "76%", "84%", "60%", "88%", "70%"];
  return (
    <div className="skeleton-block" aria-busy="true" aria-label="Loading">
      {props.title !== false && <span className="skeleton title" />}
      {Array.from({ length: props.lines ?? 4 }, (_, i) => (
        <span key={i} className="skeleton" style={{ width: widths[i % widths.length] }} />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="stack">
      <Skeleton lines={1} />
      <div className="card">
        <Skeleton lines={5} title={false} />
      </div>
    </div>
  );
}

export function BackLink(props: { href: string; children: ReactNode }) {
  return (
    <a className="back" href={props.href}>
      <Icon name="back" />
      {props.children}
    </a>
  );
}
