import { useState } from "react";
import type { ExportView } from "@clearpath/shared";
import { ApiError, useApi } from "../api";

/** Approved leads only. Blocked as a whole until the settings are complete; suppressed leads are left out. */
export function ExportPanel(props: { data: ExportView; onReload?: () => void }) {
  const { data } = props;
  const [note, setNote] = useState<string | null>(null);

  async function download() {
    setNote(null);
    try {
      const res = await fetch("/api/export.csv");
      if (!res.ok) throw new ApiError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "The export could not be created.");
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `clearpath-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNote((err as Error).message);
    }
  }

  if (data.blocked.length > 0) {
    return (
      <div className="card blocked" role="alert">
        <h3>Export is blocked</h3>
        <ul>
          {data.blocked.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <p>
          Fix these on the <a href="#/settings">Settings</a> page, then come back.
        </p>
      </div>
    );
  }
  return (
    <>
      <p>
        {data.rowCount} lead{data.rowCount === 1 ? "" : "s"} ready. The suppression list was checked before every row.
      </p>
      {data.excluded.length > 0 && (
        <div className="card attention">
          <h4>Left out</h4>
          <ul>
            {data.excluded.map((x) => (
              <li key={x.lead_id}>
                {x.firm_name}: {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button type="button" onClick={download}>
          Download CSV
        </button>
        <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(data.csv).then(() => setNote("Copied."))}>
          Copy CSV
        </button>
        {props.onReload && (
          <button type="button" className="secondary" onClick={props.onReload}>
            Refresh
          </button>
        )}
      </div>
      {note && <p className="muted">{note}</p>}
      <textarea className="csv" readOnly value={data.csv} rows={14} aria-label="CSV" />
    </>
  );
}

export function ExportPage() {
  const { data, error, reload } = useApi<ExportView>("/export");
  return (
    <section>
      <h2>Export</h2>
      {error && <p className="error">{error}</p>}
      {data && <ExportPanel data={data} onReload={reload} />}
    </section>
  );
}
