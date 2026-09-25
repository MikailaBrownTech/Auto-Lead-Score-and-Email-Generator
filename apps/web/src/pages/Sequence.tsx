import { useEffect, useRef, useState, type ReactNode } from "react";
import { countWords, type SequenceListItem, type SequenceView } from "@clearpath/shared";
import { api, useApi } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { BackLink, Badge, EmptyState, Icon, PageSkeleton, Skeleton, StatusBadge, TierChip } from "../components/ui";
import { href } from "../router";

export interface EditableEmail {
  n: number;
  subject_a: string | null;
  subject_b: string | null;
  body: string;
}

const LIVE_CHECK_MS = 400;

/** Whether Approve is allowed, and the plain reasons it is not. A missing named contact is never one. */
export function approvalState(view: SequenceView, dirty: boolean): { enabled: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (view.status === "approved") return { enabled: false, reasons: ["Already approved."] };
  if (dirty) reasons.push("Save your changes first.");
  if (!view.validationPass) reasons.push("Fix the validator errors.");
  if (view.judgeRequired && !view.judge) reasons.push("Run the judge on the current text.");
  if (view.judge && view.judge.unsupported_claims.length > 0) reasons.push("The judge listed unsupported claims.");
  return { enabled: reasons.length === 0, reasons };
}

interface Mark {
  text: string;
  className: "approved" | "personal";
  title: string;
}

/** The body with inserted text marked apart: approved docs/02 sentences (and a legacy personal line). */
export function markInserted(body: string, marks: Mark[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let rest = body;
  let key = 0;
  for (;;) {
    let first: { at: number; m: Mark } | null = null;
    for (const m of marks) {
      const at = m.text ? rest.indexOf(m.text) : -1;
      if (at >= 0 && (!first || at < first.at)) first = { at, m };
    }
    if (!first) break;
    if (first.at > 0) parts.push(<span key={key++}>{rest.slice(0, first.at)}</span>);
    parts.push(
      <mark key={key++} className={first.m.className} title={first.m.title}>
        {first.m.text}
      </mark>,
    );
    rest = rest.slice(first.at + first.m.text.length);
  }
  if (rest) parts.push(<span key={key++}>{rest}</span>);
  return parts;
}

/** The body with code-inserted approved sentences marked apart from other text. */
export function markApproved(body: string, approved: { id: string; text: string }[]): ReactNode[] {
  return markInserted(
    body,
    approved.map((a) => ({ text: a.text, className: "approved", title: `Inserted by code from docs/02 (${a.id}). Edit it and it is no longer an approved sentence.` })),
  );
}

function origin(e: SequenceView["sequence"]["emails"][number]): { text: string; tone: "neutral" | "info" | "warning" } {
  if (e.edited) return { text: "Edited by you", tone: "warning" };
  return e.template ? { text: "docs/09 fixed copy", tone: "neutral" } : { text: "Written by the model", tone: "info" };
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
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.length - errors;
  const o = origin(props.meta);
  // As sent: settings merge fields ({{offer}}, {{booking_link}}, ...) filled from docs/01 by the server.
  const rendered = view.rendered.find((r) => r.n === email.n);
  return (
    <article className={`email-card${errors ? " has-error" : warnings ? " has-warning" : ""}`} data-testid={`email-${email.n}`} aria-label={`Email ${email.n}`}>
      <header className="email-head">
        <span className="n" aria-hidden="true">
          {email.n}
        </span>
        <span className="title">Email {email.n}</span>
        <span className="muted small">day {props.meta.send_day}</span>
        <Badge tone={o.tone}>{o.text}</Badge>
        <span className="spacer" />
        {errors > 0 && (
          <Badge tone="danger" icon="error">
            {errors} error{errors > 1 ? "s" : ""}
          </Badge>
        )}
        {warnings > 0 && (
          <Badge tone="warning" icon="alert">
            {warnings} warning{warnings > 1 ? "s" : ""}
          </Badge>
        )}
        {issues.length === 0 && (
          <Badge tone="success" icon="check">
            checks pass
          </Badge>
        )}
        {props.onRewrite && (
          <button type="button" className="btn ghost sm" onClick={props.onRewrite} disabled={props.busy} title="One writer call: the model rewrites this email, seeing the whole sequence and this email's problems">
            Rewrite this email
          </button>
        )}
      </header>
      {issues.length > 0 && (
        <ul className="issues" aria-label={`Problems in email ${email.n}`}>
          {issues.map((i, k) => (
            <li key={k} className={`issue ${i.severity}`}>
              <Icon name={i.severity === "error" ? "error" : "alert"} />
              <span className="issue-text">
                <span className="issue-kind">{i.severity === "error" ? "Must fix:" : "Check:"}</span> <span>{i.message}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="email-body">
        <div className="email-edit">
          {email.n > 1 && email.subject_a !== null && (
            <label className="field">
              <span className="field-label">Subject {email.n === 4 ? "" : "(if it starts a new thread)"}</span>
              <input value={email.subject_a ?? ""} onChange={(e) => props.onChange({ ...email, subject_a: e.target.value })} />
            </label>
          )}
          {email.n === 1 && (
            <div className="subjects">
              <label className="field">
                <span className="field-label">Subject A</span>
                <input value={email.subject_a ?? ""} onChange={(e) => props.onChange({ ...email, subject_a: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-label">Subject B</span>
                <input value={email.subject_b ?? ""} onChange={(e) => props.onChange({ ...email, subject_b: e.target.value })} />
              </label>
            </div>
          )}
          <label className="field">
            <span className="field-label">Body</span>
            <textarea aria-label={`Email ${email.n} body`} value={email.body} onChange={(e) => props.onChange({ ...email, body: e.target.value })} rows={8} />
          </label>
          <div className="email-foot">
            <span className={limit && words > limit ? "status-text error" : "muted"}>
              {words} words{limit ? ` (limit ${limit})` : ""}
            </span>
          </div>
        </div>
        <div className="preview">
          <span className="eyebrow">Preview as sent</span>
          <div className="preview-box">
            {rendered?.subject_a && <span className="subject">Subject: {rendered.subject_a}</span>}
            {markInserted(rendered?.body ?? email.body, [
              ...view.approvedSentences.map((a) => ({ text: a.text, className: "approved" as const, title: `Inserted by code from docs/02 (${a.id}).` })),
              ...(props.meta.personal_line
                ? [{ text: props.meta.personal_line.text, className: "personal" as const, title: props.meta.personal_line.source === "model" ? "Personal line written by the model, checked by code." : "docs/09 fallback personal line." }]
                : []),
            ])}
            <div className="signature">{view.signature.join("\n")}</div>
          </div>
        </div>
      </div>
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
  const judgeText = !view.judgeRequired
    ? "Judge: not needed (no hand edits)"
    : view.judge
      ? view.judge.unsupported_claims.length
        ? `Judge: ${view.judge.unsupported_claims.length} unsupported claim(s)`
        : "Judge: passed"
      : "Judge: not run on this text";
  const judgeTone = !view.judgeRequired ? "muted" : view.judge ? (view.judge.unsupported_claims.length ? "error" : "ok") : "warning";

  return (
    <div className="stack">
      <div className="seq-toolbar">
        <button type="button" className="btn secondary" onClick={() => act("save", save, "Saved.")} disabled={!dirty || !!busy}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn secondary"
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
          title={view.judgeRequired ? "Checks the emails you edited by hand for unsupported claims" : "Nothing edited by hand: nothing to judge"}
        >
          {busy === "judge" ? "Judging…" : "Run judge"}
        </button>
        <button
          type="button"
          className="btn primary"
          onClick={() => act("approve", () => api<SequenceView>(`/sequences/${view.id}/approve`, { method: "POST" }), "Approved.")}
          disabled={!approval.enabled || !!busy}
          aria-describedby={!approval.enabled ? "approve-reasons" : undefined}
        >
          Approve
        </button>
        <div className="statuses">
          <span className={`status-text ${errors ? "error" : "ok"}`}>
            <Icon name={errors ? "error" : "check"} />
            {errors ? `${errors} validator error${errors > 1 ? "s" : ""}` : "Validators pass"}
          </span>
          <span className={`status-text ${judgeTone}`}>
            <Icon name={judgeTone === "ok" ? "check" : judgeTone === "error" ? "error" : judgeTone === "warning" ? "alert" : "info"} />
            {judgeText}
          </span>
        </div>
        {!approval.enabled && (
          <div className="approve-reasons" id="approve-reasons">
            <Icon name={view.status === "approved" ? "check" : "info"} />
            <span>{view.status === "approved" ? "" : "Approve is disabled:"}</span>
            <ul aria-label="Why Approve is disabled">
              {approval.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {message && <NoticeBanner tone="success">{message}</NoticeBanner>}
      {view.contactWarning && (
        <NoticeBanner>
          Contact: {view.contactWarning}. This is a warning only; it does not block approval or export.
        </NoticeBanner>
      )}
      {view.kind === "template" && (
        <NoticeBanner tone="info">
          An older sequence: the docs/09 fixed copy with the lead's details filled in, from before every tier was written by the model. No model was used, so no judge is needed. Edit it by hand, or choose Rewrite this email to have the model write it instead.
        </NoticeBanner>
      )}
      {!view.validationPass && (
        <NoticeBanner>A validator error remains after the one rewrite. It is shown on the email below: edit it and save, or choose Rewrite this email.</NoticeBanner>
      )}
      {view.issues
        .filter((i) => i.email === null)
        .map((i, k) => (
          <div key={k} className={`issue ${i.severity}`}>
            <Icon name={i.severity === "error" ? "error" : "alert"} />
            <span className="issue-text">
              <span className="issue-kind">{i.severity === "error" ? "Must fix:" : "Check:"}</span> <span>{i.message}</span>
            </span>
          </div>
        ))}
      {view.judge && view.judge.unsupported_claims.length > 0 && (
        <section className="card tone-danger">
          <h2 style={{ marginBottom: 8 }}>Judge: unsupported claims</h2>
          <ul className="small">
            {view.judge.unsupported_claims.map((c, k) => (
              <li key={k}>
                Email {c.email}: “{c.claim}” ({c.reason.replace(/_/g, " ")})
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.drafts.length > 0 && (
        <details className="card">
          <summary>Writer drafts for this sequence ({view.drafts.length})</summary>
          <div className="stack-sm small">
            {view.drafts.map((d) => (
              <div key={d.attempt}>
                <strong>{d.attempt === 1 ? "First draft" : "Rewrite"}</strong>:{" "}
                {d.formatProblem ? `could not be used (${d.formatProblem})` : d.errors.length === 0 ? "passed the validators" : `${d.errors.length} validator error(s)`}
                {d.errors.length > 0 && (
                  <ul>
                    {d.errors.map((i, k) => (
                      <li key={k}>
                        {i.email ? `Email ${i.email}: ` : ""}
                        {i.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <p className="legend">
        <mark className="approved">Approved sentence</mark>
        <span>is the exact VERIFIED docs/02 sentence, inserted by code where the writer marked it. The model never states a rule itself.</span>
      </p>
      <div className="email-stack">
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
    </div>
  );
}

export function SequencePage(props: { id: string }) {
  const { data, error } = useApi<SequenceView>(`/sequences/${encodeURIComponent(props.id)}`);
  if (error)
    return (
      <section className="stack">
        <BackLink href={href("sequences")}>Sequences</BackLink>
        <ErrorBanner message={error} />
      </section>
    );
  if (!data) return <PageSkeleton />;
  return (
    <section className="stack">
      <BackLink href={href("leads", data.leadId)}>{data.firm ?? data.leadId}</BackLink>
      <div className="page-head">
        <div>
          <h1>Sequence for {data.firm ?? data.leadId}</h1>
          <div className="lead-meta">
            <TierChip tier={data.tier} />
            <StatusBadge status={data.status} />
            {data.kind === "template" ? <Badge>docs/09 fixed copy (no model call)</Badge> : <Badge tone="info">Written by the model</Badge>}
          </div>
        </div>
      </div>
      <SequenceEditor key={data.id} initial={data} />
    </section>
  );
}

/** Every lead's newest sequence, templates included. */
export function SequencesPage() {
  const { data, error, reload } = useApi<SequenceListItem[]>("/sequences");
  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Sequences</h1>
          <p className="sub">Each lead's newest five-email sequence. Open one to edit, judge, and approve it.</p>
        </div>
        <button type="button" className="btn secondary" onClick={reload}>
          <Icon name="refresh" />
          Refresh
        </button>
      </div>
      <ErrorBanner message={error} />
      {!data && !error && (
        <div className="card">
          <Skeleton lines={4} title={false} />
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon="mail"
          title="No sequences yet"
          action={
            <a className="btn secondary" href={href("leads")}>
              Go to Leads
            </a>
          }
        >
          Open a lead and choose Write sequence.
        </EmptyState>
      )}
      {data && data.length > 0 && (
        <div className="table-wrap scroll">
          <table className="data">
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
                  <td className="primary-cell">
                    <a href={href("sequences", s.id)}>{s.firm ?? s.leadId}</a>
                  </td>
                  <td>
                    <TierChip tier={s.tier} />
                  </td>
                  <td>{s.kind === "template" ? <Badge>docs/09 fixed copy (no model call)</Badge> : <Badge tone="info">Written by the model</Badge>}</td>
                  <td>
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="nowrap muted">{s.createdAt.slice(0, 16).replace("T", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
