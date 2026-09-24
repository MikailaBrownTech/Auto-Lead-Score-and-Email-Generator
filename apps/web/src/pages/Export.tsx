import { useState } from "react";
import type { ExportView } from "@clearpath/shared";
import { ApiError, plainApiError, useApi } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { Icon, Skeleton } from "../components/ui";

type Mode = ExportView["mode"];

const MODES: [Mode, string][] = [
  ["ready", "Ready to send"],
  ["drafts", "Drafts"],
];

/**
 * Approved leads only. Blocked as a whole until the settings are complete; suppressed leads are left
 * out. "Ready to send" has rows with an address; "Drafts" has every approved row (send_ready N
 * and a contact_note when there is no address). Addresses are never guessed.
 */
export function ExportPanel(props: { data: ExportView; onReload?: () => void; onMode?: (m: Mode) => void }) {
  const { data } = props;
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function download() {
    setNote(null);
    setFailure(null);
    try {
      const res = await fetch(`/api/export.csv?mode=${data.mode}`);
      if (!res.ok) throw new ApiError(plainApiError(res.status, ((await res.json().catch(() => null)) as { error?: string } | null)?.error));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `clearpath-${data.mode === "drafts" ? "drafts" : "ready-to-send"}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFailure((err as Error).message);
    }
  }

  if (data.blocked.length > 0) {
    return (
      <div className="card tone-danger" role="alert">
        <div className="card-head">
          <h2 className="row">
            <Icon name="error" />
            Export is blocked
          </h2>
        </div>
        <ul className="small">
          {data.blocked.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <p className="small" style={{ marginTop: 12 }}>
          Fix these on the <a href="#/settings">Settings</a> page, then come back.
        </p>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="row between">
        <div className="segmented" role="group" aria-label="Export mode">
          {MODES.map(([m, label]) => (
            <button key={m} type="button" aria-pressed={data.mode === m} onClick={() => props.onMode?.(m)}>
              {label} ({m === "ready" ? data.readyCount : data.draftCount})
            </button>
          ))}
        </div>
        <div className="row">
          {props.onReload && (
            <button type="button" className="btn ghost" onClick={props.onReload}>
              <Icon name="refresh" />
              Refresh
            </button>
          )}
          <button type="button" className="btn secondary" onClick={() => void navigator.clipboard.writeText(data.csv).then(() => setNote("Copied."))}>
            Copy CSV
          </button>
          <button type="button" className="btn primary" onClick={download}>
            <Icon name="download" />
            Download CSV
          </button>
        </div>
      </div>
      <div className="export-summary">
        <div className="stat">
          <span className="value">{data.rowCount}</span>
          <span className="label">
            row{data.rowCount === 1 ? "" : "s"} in this CSV ({data.mode === "ready" ? "leads with an email address" : "every approved lead"})
          </span>
        </div>
        <div className="stat">
          <span className="value">{data.excluded.length}</span>
          <span className="label">left out (listed below)</span>
        </div>
      </div>
      <p className="small muted">
        The suppression list was checked before every row. Columns send_ready (Y/N) and contact_note say whether a row can be sent as is.
        {data.mode === "drafts" && " Rows without an address have send_ready N: add an address before sending. Addresses are never guessed."}
      </p>
      {data.excluded.length > 0 && (
        <NoticeBanner>
          <strong>Left out</strong>
          <ul className="plain" style={{ marginTop: 4 }}>
            {data.excluded.map((x) => (
              <li key={x.lead_id}>
                {x.firm_name}: {x.reason}
              </li>
            ))}
          </ul>
        </NoticeBanner>
      )}
      <ErrorBanner message={failure} onDismiss={() => setFailure(null)} />
      {note && <NoticeBanner tone="success">{note}</NoticeBanner>}
      <label className="field">
        <span className="field-label">CSV preview</span>
        <textarea className="csv" readOnly value={data.csv} rows={12} aria-label="CSV" />
      </label>
    </div>
  );
}

export function ExportPage() {
  const [mode, setMode] = useState<Mode>("ready");
  const { data, error, reload } = useApi<ExportView>(`/export?mode=${mode}`);
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Export</h1>
          <p className="sub">Approved sequences as a CSV for your sending tool. Nothing is sent from here.</p>
        </div>
      </div>
      <ErrorBanner message={error} />
      {!data && !error && (
        <div className="card">
          <Skeleton lines={4} title={false} />
        </div>
      )}
      {data && <ExportPanel data={data} onReload={reload} onMode={setMode} />}
    </section>
  );
}
