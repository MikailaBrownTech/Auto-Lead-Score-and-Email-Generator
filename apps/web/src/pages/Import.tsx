import { useEffect, useState } from "react";
import type { JobView } from "@clearpath/shared";
import { api } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { Badge, type Tone } from "../components/ui";
import { href } from "../router";

const MAX_URLS = 5;
const POLL_MS = 1500;
/** After this long, a running job shows a "still working" notice. */
export const STALE_MINUTES = 3;

const STATE_TEXT: Record<string, [string, Tone]> = {
  queued: ["Waiting", "neutral"],
  researching: ["Researching", "info"],
  writing: ["Writing emails", "info"],
  done: ["Done", "success"],
  failed: ["Failed", "danger"],
  cancelled: ["Cancelled", "neutral"],
};

/** Polls a job until every item is finished. */
export function useJob(jobId: string | null): { job: JobView | null; error: string | null; setJob: (j: JobView) => void } {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api<JobView>(`/jobs/${jobId}`);
        if (cancelled) return;
        setJob(j);
        if (!j.finished && j.items.some((i) => ["queued", "researching", "writing"].includes(i.state))) timer = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId]);
  return { job, error, setJob };
}

export function JobStatus(props: { job: JobView; onCancel?: () => void }) {
  const running = props.job.items.some((i) => ["queued", "researching", "writing"].includes(i.state));
  const minutes = Math.floor((Date.now() - Date.parse(props.job.createdAt)) / 60_000);
  return (
    <div className="card stack-sm">
      {/* A job that never completes is never silent: say how long it has been and where to look. */}
      {running && minutes >= STALE_MINUTES && (
        <NoticeBanner>
          Still working after {minutes} minutes. Each site is read politely (1 request per second) and each model call can take up to 2 minutes. If nothing changes, open the lead page: it shows the last result, or restart the app.
        </NoticeBanner>
      )}
      <div className="row between">
        <h2>{running ? "Working…" : "Finished"}</h2>
        {running && props.onCancel && (
          <button type="button" className="btn danger sm" onClick={props.onCancel} disabled={props.job.cancelRequested}>
            {props.job.cancelRequested ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Lead</th>
            <th>Step</th>
            <th>Details</th>
          </tr>
        </thead>
        <tbody>
          {props.job.items.map((i) => (
            <tr key={i.leadId}>
              <td className="primary-cell">{i.state === "done" ? <a href={href("leads", i.leadId)}>{i.label}</a> : i.label}</td>
              <td>
                <Badge tone={STATE_TEXT[i.state]![1]}>{STATE_TEXT[i.state]![0]}</Badge>
              </td>
              <td>
                {i.message}
                {i.tier && ` · tier ${i.tier}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

export function ImportPage() {
  const [mode, setMode] = useState<"web" | "paste">("web");
  const [urls, setUrls] = useState("");
  const [label, setLabel] = useState("");
  const [text, setText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job, error: pollError, setJob } = useJob(jobId);
  const list = urls.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const running = job?.items.some((i) => ["queued", "researching", "writing"].includes(i.state)) ?? false;

  async function start() {
    setError(null);
    try {
      const j = await api<JobView>("/jobs", { method: "POST", body: mode === "web" ? { mode, urls: list } : { mode, label, text } });
      setJob(j);
      setJobId(j.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Import leads</h1>
          <p className="sub">Research runs one site at a time, politely (robots.txt, 1 request per second). Each lead's cost shows on the Leads page.</p>
        </div>
      </div>
      <div className="card stack">
        <div className="segmented" role="tablist" aria-label="Import from">
          <button type="button" role="tab" aria-selected={mode === "web"} onClick={() => setMode("web")}>
            Websites
          </button>
          <button type="button" role="tab" aria-selected={mode === "paste"} onClick={() => setMode("paste")}>
            Paste text
          </button>
        </div>
        {mode === "web" ? (
          <label className="field">
            <span className="field-label">Website addresses, one per line (up to {MAX_URLS})</span>
            <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={6} placeholder={"smithtax.com\nexamplecpa.com"} />
            <span className={list.length > MAX_URLS ? "field-hint error" : "field-hint"}>
              {list.length} of {MAX_URLS}
            </span>
          </label>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Lead label (for example the firm's name)</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Pasted text (a LinkedIn bio or About page)</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} />
              <span className="field-hint">This text is the only source of facts; nothing is fetched.</span>
            </label>
          </>
        )}
        <div className="row">
          <button type="button" className="btn primary" onClick={start} disabled={running || (mode === "web" ? list.length === 0 || list.length > MAX_URLS : !label.trim() || !text.trim())}>
            Start
          </button>
        </div>
      </div>
      <ErrorBanner message={error ?? pollError} />
      {job && (
        <JobStatus
          job={job}
          onCancel={async () => {
            try {
              setJob(await api<JobView>(`/jobs/${job.id}/cancel`, { method: "POST" }));
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </section>
  );
}
