import { useEffect, useState } from "react";
import type { JobView } from "@clearpath/shared";
import { api } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { href } from "../router";

const MAX_URLS = 5;
const POLL_MS = 1500;
/** After this long, a running job shows a "still working" notice. */
export const STALE_MINUTES = 3;

const STATE_TEXT: Record<string, string> = {
  queued: "Waiting",
  researching: "Researching",
  writing: "Writing emails",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
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
    <div className="card">
      {/* A job that never completes is never silent: say how long it has been and where to look. */}
      {running && minutes >= STALE_MINUTES && (
        <NoticeBanner>
          Still working after {minutes} minutes. Each site is read politely (1 request per second) and each model call can take up to 2 minutes. If nothing changes, open the lead page: it shows the last result, or restart the app.
        </NoticeBanner>
      )}
      <div className="row between">
        <strong>{running ? "Working…" : "Finished"}</strong>
        {running && props.onCancel && (
          <button type="button" className="secondary" onClick={props.onCancel} disabled={props.job.cancelRequested}>
            {props.job.cancelRequested ? "Cancelling…" : "Cancel"}
          </button>
        )}
      </div>
      <table>
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
              <td>{i.state === "done" ? <a href={href("leads", i.leadId)}>{i.label}</a> : i.label}</td>
              <td>
                <span className={`badge state-${i.state}`}>{STATE_TEXT[i.state]}</span>
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
    <section>
      <h2>Import leads</h2>
      <div className="tabs">
        <button type="button" className={mode === "web" ? "tab active" : "tab"} onClick={() => setMode("web")}>
          Websites
        </button>
        <button type="button" className={mode === "paste" ? "tab active" : "tab"} onClick={() => setMode("paste")}>
          Paste text
        </button>
      </div>
      {mode === "web" ? (
        <label>
          Website addresses, one per line (up to {MAX_URLS})
          <textarea value={urls} onChange={(e) => setUrls(e.target.value)} rows={6} placeholder={"smithtax.com\nexamplecpa.com"} />
          <span className={list.length > MAX_URLS ? "error" : "muted"}>
            {list.length} of {MAX_URLS}
          </span>
        </label>
      ) : (
        <>
          <label>
            Lead label (for example the firm's name)
            <input value={label} onChange={(e) => setLabel(e.target.value)} />
          </label>
          <label>
            Pasted text (a LinkedIn bio or About page). This text is the only source of facts; nothing is fetched.
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} />
          </label>
        </>
      )}
      <div className="row">
        <button type="button" onClick={start} disabled={running || (mode === "web" ? list.length === 0 || list.length > MAX_URLS : !label.trim() || !text.trim())}>
          Start
        </button>
        <span className="muted">Research runs one site at a time, politely (robots.txt, 1 request per second). Each lead's cost shows on the Leads page.</span>
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
