import { useEffect, useRef, useState, type ReactNode } from "react";
import { countWords, type SequenceListItem, type SequenceView } from "@clearpath/shared";
import { api, useApi } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { href } from "../router";

export interface EditableEmail {
  n: number;
  subject_a: string | null;
  subject_b: string | null;
  body: string;
}

const LIVE_CHECK_MS = 400;

/** Whether Approve is allowed, and the plain reasons it is not. */
export function approvalState(view: SequenceView, dirty: boolean): { enabled: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (view.status === "approved") return { enabled: false, reasons: ["Already approved."] };
  if (dirty) reasons.push("Save your changes first.");
  if (!view.validationPass) reasons.push("Fix the validator errors.");
  if (view.judgeRequired && !view.judge) reasons.push("Run the judge on the current text.");
  if (view.judge && view.judge.unsupported_claims.length > 0) reasons.push("The judge listed unsupported claims.");
  reasons.push(...view.approvalBlockers);
  return { enabled: reasons.length === 0, reasons };
}

/** The body with code-inserted approved sentences marked apart from other text. */
export function markApproved(body: string, approved: { id: string; text: string }[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = body;
  let key = 0;
  for (;;) {
    let first: { at: number; a: { id: string; text: string } } | null = null;
    for (const a of approved) {
      const at = rest.indexOf(a.text);
      if (at >= 0 && (!first || at < first.at)) first = { at, a };
    }
    if (!first) break;
    if (first.at > 0) parts.push(<span key={key++}>{rest.slice(0, first.at)}</span>);
    parts.push(
      <mark key={key++} className="approved" title={`Inserted by code from docs/02 (${first.a.id}). Edit it and it is no longer an approved sentence.`}>
        {first.a.text}
      </mark>,
    );
    rest = rest.slice(first.at + first.a.text.length);
  }
  if (rest) parts.push(<span key={key++}>{rest}</span>);
  return parts;
}

function origin(e: SequenceView["sequence"]["emails"][number]): string {
  if (e.edited) return "Edited by you";
  return e.template ? "Template (no model call)" : "Written by the model";
}

export function EmailCard(props: {
  email: EditableEmail;
  meta: SequenceView["sequence"]["emails"][number];
  view: SequenceView;
  onChange: (e: EditableEmail) => void;
  onRewrite?: () => void;
  busy: boolean;
}) {
  const { email, view } = props;
  const words = countWords(email.body);
  const limit = view.wordLimits[String(email.n)];
  const issues = view.issues.filter((i) => i.email === email.n);
  return (
    <article className="email-card" data-testid={`email-${email.n}`}>
      <header className="row between">
        <strong>
          Email {email.n} · day {props.meta.send_day}
        </strong>
        <span className={props.meta.template && !props.meta.edited ? "badge template" : "badge"}>{origin(props.meta)}</span>
      </header>
      {email.n === 1 && (
        <div className="row">
          <label>
            Subject A
            <input value={email.subject_a ?? ""} onChange={(e) => props.onChange({ ...email, subject_a: e.target.value })} />
          </label>
          <label>
            Subject B
            <input value={email.subject_b ?? ""} onChange={(e) => props.onChange({ ...email, subject_b: e.target.value })} />
          </label>
        </div>
      )}
      <label>
        Body
        <textarea aria-label={`Email ${email.n} body`} value={email.body} onChange={(e) => props.onChange({ ...email, body: e.target.value })} rows={7} />
      </label>
      <div className="row between small">
        <span className={limit && words > limit ? "error" : "muted"}>
          {words} words{limit ? ` (limit ${limit})` : ` (break-up: ${view.breakupSentences.min}-${view.breakupSentences.max} sentences)`}
        </span>
        {props.onRewrite && (
          <button type="button" className="secondary" onClick={props.onRewrite} disabled={props.busy}>
            Rewrite this email
          </button>
        )}
      </div>
      <div className="preview">
        {markApproved(email.body, view.approvedSentences)}
        <div className="signature">{view.signature.join("\n")}</div>
      </div>
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i, k) => (
            <li key={k} className={i.severity}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

const toEditable = (v: SequenceView): EditableEmail[] => v.sequence.emails.map((e) => ({ n: e.n, subject_a: e.subject_a, subject_b: e.subject_b, body: e.body }));

/**
 * Editable sequence. Code validators re-run on the server as you type (debounced); the judge runs on
 * demand; Approve stays disabled until validators and judge both pass on the saved text.
 */
export function SequenceEditor(props: { initial: SequenceView }) {
  const [view, setView] = useState<SequenceView>(props.initial);
  const [emails, setEmails] = useState<EditableEmail[]>(() => toEditable(props.initial));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function edit(next: EditableEmail) {
    const all = emails.map((e) => (e.n === next.n ? next : e));
    setEmails(all);
    setDirty(true);
    setMessage(null);
    if (timer.current) clearTimeout(timer.current);
    const mine = ++seq.current;
    timer.current = setTimeout(async () => {
      try {
        const checked = await api<SequenceView>(`/sequences/${view.id}/check`, { method: "POST", body: { emails: all } });
        if (mine === seq.current) setView(checked);
      } catch (err) {
        setError((err as Error).message);
      }
    }, LIVE_CHECK_MS);
  }

  async function act(label: string, fn: () => Promise<SequenceView>, done: string) {
    setBusy(label);
    setError(null);
    setMessage(null);
    try {
      const v = await fn();
      setView(v);
      setEmails(toEditable(v));
      setDirty(false);
      setMessage(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const save = () => api<SequenceView>(`/sequences/${view.id}`, { method: "PUT", body: { emails } });
  const approval = approvalState(view, dirty);
  const errors = view.issues.filter((i) => i.severity === "error").length;

  return (
    <div>
      <div className="toolbar row">
        <button type="button" onClick={() => act("save", save, "Saved.")} disabled={!dirty || !!busy}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={() =>
            act(
              "judge",
              async () => {
                if (dirty) await save();
                return api<SequenceView>(`/sequences/${view.id}/judge`, { method: "POST" });
              },
              "Judge finished.",
            )
          }
          disabled={!!busy || !view.judgeRequired}
          title={view.judgeRequired ? "Checks the model-written and edited emails for unsupported claims" : "Only fixed templates: nothing to judge"}
        >
          {busy === "judge" ? "Judging…" : "Run judge"}
        </button>
        <button type="button" className="approve" onClick={() => act("approve", () => api<SequenceView>(`/sequences/${view.id}/approve`, { method: "POST" }), "Approved.")} disabled={!approval.enabled || !!busy}>
          Approve
        </button>
        <span className={errors ? "error" : "ok"}>{errors ? `${errors} validator error${errors > 1 ? "s" : ""}` : "Validators pass"}</span>
        <span className="muted">
          Judge: {!view.judgeRequired ? "not needed (templates only)" : view.judge ? (view.judge.unsupported_claims.length ? `${view.judge.unsupported_claims.length} unsupported claim(s)` : "passed") : "not run on this text"}
        </span>
      </div>
      {!approval.enabled && (
        <ul className="reasons small" aria-label="Why Approve is disabled">
          {approval.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {message && <p className="ok">{message}</p>}
      {view.kind === "template" && (
        <NoticeBanner tone="info">Template (no model call): every email is fixed docs/09 text with the greeting and firm name filled in. No model was used, so no judge is needed.</NoticeBanner>
      )}
      {!view.validationPass && <NoticeBanner>This draft is blocked by the validators. It is shown in full below with its errors: edit it and save, or rewrite an email.</NoticeBanner>}
      {view.issues.filter((i) => i.email === null).map((i, k) => (
        <p key={k} className={i.severity}>
          {i.message}
        </p>
      ))}
      {view.judge && view.judge.unsupported_claims.length > 0 && (
        <div className="card attention">
          <h4>Judge: unsupported claims</h4>
          <ul>
            {view.judge.unsupported_claims.map((c, k) => (
              <li key={k}>
                Email {c.email}: “{c.claim}” ({c.reason.replace(/_/g, " ")})
              </li>
            ))}
          </ul>
        </div>
      )}
      {view.drafts.length > 0 && (
        <details className="card">
          <summary>Model drafts for this sequence ({view.drafts.length})</summary>
          {view.drafts.map((d) => (
            <div key={d.attempt}>
              <strong>{d.attempt === 1 ? "First draft" : "Rewrite"}</strong>:{" "}
              {d.formatProblem ? `could not be used (${d.formatProblem})` : d.errors.length === 0 ? "passed the validators" : `${d.errors.length} validator error(s)`}
              {d.errors.length > 0 && (
                <ul className="issues">
                  {d.errors.map((i, k) => (
                    <li key={k} className="error">
                      {i.email ? `Email ${i.email}: ` : ""}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </details>
      )}
      <p className="legend small">
        <mark className="approved">Highlighted</mark> sentences were inserted by code from docs/02. Everything else is model-written or template text.
      </p>
      {emails.map((e) => (
        <EmailCard
          key={e.n}
          email={e}
          meta={view.sequence.emails.find((m) => m.n === e.n)!}
          view={view}
          busy={!!busy}
          onChange={edit}
          {...(view.rewritable.includes(e.n)
            ? { onRewrite: () => act(`rewrite-${e.n}`, () => api<SequenceView>(`/sequences/${view.id}/rewrite`, { method: "POST", body: { n: e.n } }), `Email ${e.n} rewritten. Run the judge again.`) }
            : {})}
        />
      ))}
    </div>
  );
}

export function SequencePage(props: { id: string }) {
  const { data, error } = useApi<SequenceView>(`/sequences/${encodeURIComponent(props.id)}`);
  if (error) return <ErrorBanner message={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <section>
      <p>
        <a href={href("leads", data.leadId)}>← {data.firm ?? data.leadId}</a>
      </p>
      <h2>
        Sequence for {data.firm ?? data.leadId} <span className="muted">(tier {data.tier})</span>{" "}
        {data.kind === "template" && <span className="badge template">Template (no model call)</span>}
      </h2>
      <SequenceEditor key={data.id} initial={data} />
    </section>
  );
}

/** Every lead's newest sequence, templates included. */
export function SequencesPage() {
  const { data, error, reload } = useApi<SequenceListItem[]>("/sequences");
  return (
    <section>
      <div className="row between">
        <h2>Sequences</h2>
        <button type="button" className="secondary" onClick={reload}>
          Refresh
        </button>
      </div>
      <ErrorBanner message={error} />
      {data && data.length === 0 && <p className="muted">No sequences yet. Open a lead and choose Write sequence.</p>}
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Firm</th>
              <th>Tier</th>
              <th>Kind</th>
              <th>Status</th>
              <th>Written</th>
            </tr>
          </thead>
          <tbody>
            {data.map((s) => (
              <tr key={s.id}>
                <td>
                  <a href={href("sequences", s.id)}>{s.firm ?? s.leadId}</a>
                </td>
                <td>{s.tier}</td>
                <td>{s.kind === "template" ? <span className="badge template">Template (no model call)</span> : <span className="badge">Written by the model</span>}</td>
                <td>{s.status}</td>
                <td>{s.createdAt.slice(0, 16).replace("T", " ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
