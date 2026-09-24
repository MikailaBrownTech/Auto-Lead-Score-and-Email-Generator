import { useState, type ReactNode } from "react";
import type { JobView, LeadDetail, SequenceView } from "@clearpath/shared";
import { api, useApi, usd } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { ReasonForm } from "../components/ReasonForm";
import { Scorecard } from "../components/Scorecard";
import { BackLink, Badge, Icon, PageSkeleton, StatusBadge } from "../components/ui";
import { href, navigate } from "../router";
import { JobStatus, useJob } from "./Import";
import { Flags } from "./Leads";

/** Dossier fields in reading order, with plain labels. */
const FIELDS: [string, string][] = [
  ["firm_name", "Firm name"],
  ["firm_type", "Firm type"],
  ["location", "Location"],
  ["size_signal", "Staff size"],
  ["services", "Services"],
  ["software_mentioned", "Software"],
  ["people", "People named"],
  ["decision_maker", "Decision maker (chosen by code)"],
  ["public_contact_email", "Public email"],
  ["personal_email_domain_on_site", "Personal email provider used"],
  ["phone_or_contact_form", "Phone or contact form"],
  ["client_portal_or_doc_exchange", "Document exchange / portal"],
  ["privacy_policy_present", "Privacy policy"],
  ["security_or_wisp_mention", "Security / WISP mention"],
  ["latest_dated_content", "Newest dated content (code)"],
  ["exclusion_signals", "Exclusion signals"],
];

const NotFound = () => (
  <Badge mono title="Not found on the pages that were read. Never treated as a negative finding.">
    NOT_FOUND
  </Badge>
);

function Evidence(props: { url: string; quote?: string }) {
  const link = /^https?:\/\//.test(props.url) ? (
    <a className="source" href={props.url} target="_blank" rel="noreferrer noopener" title={props.url}>
      source
      <Icon name="external" />
    </a>
  ) : (
    <span className="source">{props.url === "pasted" ? "pasted text" : props.url}</span>
  );
  return (
    <div className="evidence">
      {props.quote && <q className="quote">{props.quote}</q>}
      {link}
    </div>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(show).join(", ");
  return Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== null && x !== undefined && !(Array.isArray(x) && x.length === 0))
    .map(([k, x]) => `${k.replace(/_/g, " ")}: ${show(x)}`)
    .join("; ");
}

/** One dossier field: value + evidence quote + source link, or a gray NOT_FOUND badge. */
export function FieldValue(props: { value: unknown }): ReactNode {
  const v = props.value;
  if (v === "NOT_FOUND" || v === undefined) return <NotFound />;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="muted">none</span>;
    return (
      <ul className="plain">
        {v.map((item: Record<string, unknown>, i) => {
          const { evidence_url, evidence_quote, ...rest } = item;
          return (
            <li key={i}>
              {show(rest)}
              <Evidence url={String(evidence_url)} quote={String(evidence_quote)} />
            </li>
          );
        })}
      </ul>
    );
  }
  const f = v as { value?: unknown; evidence_url?: string; evidence_quote?: string; evidence?: { item: string; evidence_url: string }[] };
  if (f.evidence) {
    return (
      <ul className="plain">
        {f.evidence.map((e) => (
          <li key={e.item} className="row">
            <span>{e.item}</span>
            <Evidence url={e.evidence_url} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      {show(f.value)}
      {f.evidence_url && <Evidence url={f.evidence_url} quote={f.evidence_quote} />}
    </>
  );
}

function PasteForm(props: { leadId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [text, setText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { job } = useJob(jobId);
  const finished = job && job.items.every((i) => !["queued", "researching", "writing"].includes(i.state));
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          const j = await api<JobView>(`/leads/${props.leadId}/paste`, { method: "POST", body: { ownerName: name, ownerEmail: email, text } });
          setJobId(j.id);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p className="small muted">This re-runs the lead in paste mode: only what you paste here is used, so include the About or Services text too.</p>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Owner's name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Owner's email</span>
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </label>
        <label className="field span-2">
          <span className="field-label">Page text</span>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} />
        </label>
      </div>
      <div className="row">
        <button type="submit" className="btn secondary" disabled={!!jobId && !finished}>
          Re-run with pasted text
        </button>
        {finished && (
          <button type="button" className="btn ghost" onClick={props.onDone}>
            Show the updated lead
          </button>
        )}
      </div>
      <ErrorBanner message={error} />
      {job && <JobStatus job={job} />}
    </form>
  );
}

/** Contact: a warning only (never a blocker), optional public sources, paste mode, optional override. */
function ContactCard(props: { lead: LeadDetail; onChange: (l: LeadDetail) => void; reload: () => void }) {
  const { lead } = props;
  const c = lead.contact;
  const declined = lead.dossier.declined_automated_access;
  if (c.named && !declined) {
    return (
      <section className="card">
        <div className="card-head">
          <h2>Contact</h2>
          <Badge tone="success" icon="user">
            named contact
          </Badge>
        </div>
        <p className="small">
          Email 1 greets “{c.greeting}”: the public address is tied to that person.
        </p>
      </section>
    );
  }
  return (
    <section className={`card${c.warning ? " tone-warning" : ""}`}>
      <div className="card-head">
        <h2>Contact</h2>
        {c.warning && (
          <Badge tone="warning" icon="alert">
            {c.warning}
          </Badge>
        )}
      </div>
      <div className="stack-sm">
        {c.warning && (
          <p className="small">
            Drafting, approval, and export are not blocked. Email 1 opens with the docs/09 role-based line (no name) and stays specific to this firm.
            {c.warning.startsWith("no public email") && " Without an address, approved sequences export only in the Drafts CSV (send_ready N)."}
          </p>
        )}
        {declined && (
          <NoticeBanner>The site answered HTTP 403/429, so no more pages were requested. Paste the About, Team, or Contact text to research it fully.</NoticeBanner>
        )}
        {c.override && (
          <NoticeBanner tone="success">
            You marked this contact as fine: “{c.override.reason}”. Email 1 opens with the role-based line.
          </NoticeBanner>
        )}
        {c.checklist.length > 0 && (
          <>
            <h3 className="small">Optional: find an owner name or email to improve reply odds</h3>
            <ul className="checklist">
              {c.checklist.map((line) => (
                <li key={line}>{line.replace(/^\[ \] /, "")}</li>
              ))}
            </ul>
          </>
        )}
        <details className="card tone-muted" open={declined}>
          <summary>Paste the owner's details or page text</summary>
          <PasteForm leadId={lead.id} onDone={props.reload} />
        </details>
        {!c.named && !c.override && (
          <details className="card tone-muted">
            <summary>Mark this contact as fine (optional)</summary>
            <ReasonForm
              label="For example, a solo practice whose only address is the owner's inbox. This only clears the label; nothing is blocked either way."
              button="Mark as fine"
              onSubmit={async (reason) => props.onChange(await api<LeadDetail>(`/leads/${lead.id}/override-contact`, { method: "POST", body: { reason } }))}
            />
          </details>
        )}
      </div>
    </section>
  );
}

export function LeadDetailPage(props: { id: string }) {
  const { data: lead, error, reload, setData } = useApi<LeadDetail>(`/leads/${encodeURIComponent(props.id)}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (error)
    return (
      <section className="stack">
        <BackLink href={href("leads")}>Leads</BackLink>
        <ErrorBanner message={error} />
      </section>
    );
  if (!lead) return <PageSkeleton />;
  const d = lead.dossier;

  async function writeSequence() {
    setBusy(true);
    setActionError(null);
    try {
      const s = await api<SequenceView>(`/leads/${lead!.id}/sequence`, { method: "POST" });
      navigate("sequences", s.id);
    } catch (err) {
      setActionError((err as Error).message);
      reload(); // picks up the logged reason, so it stays visible after leaving this page
    } finally {
      setBusy(false);
    }
  }

  const gated = d.gate.status !== "qualified";
  return (
    <section className="stack">
      <BackLink href={href("leads")}>Leads</BackLink>
      <div className="page-head">
        <div className="grow">
          <h1 className="break">{d.firm_name !== "NOT_FOUND" ? d.firm_name.value : lead.id}</h1>
          <div className="lead-meta">
            {lead.inputUrl ? (
              <a href={/^https?:/.test(lead.inputUrl) ? lead.inputUrl : `https://${lead.inputUrl}`} target="_blank" rel="noreferrer noopener" className="break">
                {lead.inputUrl}
              </a>
            ) : (
              <span>pasted text</span>
            )}
            <StatusBadge status={d.gate.status} />
            <StatusBadge status={lead.status} />
            <span>spent {usd(lead.costUsd)}</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Flags flags={lead.flags} />
          </div>
        </div>
        <div className="lead-actions">
          {lead.sequenceId && (
            <a className="btn secondary" href={href("sequences", lead.sequenceId)}>
              <Icon name="mail" />
              Open sequence ({lead.sequenceStatus})
            </a>
          )}
          <button type="button" className="btn primary" onClick={writeSequence} disabled={busy || !!lead.notWrittenReason}>
            <Icon name="pen" />
            {busy ? "Writing… (about 10-30 seconds)" : lead.sequenceId ? "Write the sequence again" : "Write sequence"}
          </button>
        </div>
      </div>
      {lead.tier === "C" && !lead.notWrittenReason && <p className="small muted">Tier C: docs/09 copy with the fallback personal line, no model call.</p>}
      {/* Why nothing was (or can be) written, always in words next to the button. */}
      {lead.notWrittenReason && <NoticeBanner>{lead.notWrittenReason} (See the gate box below.)</NoticeBanner>}
      {lead.lastWriteAttempt && (
        <NoticeBanner>
          Last write attempt ({lead.lastWriteAttempt.at.slice(0, 16).replace("T", " ")}): {lead.lastWriteAttempt.detail}
        </NoticeBanner>
      )}
      <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />

      <div className="lead-grid">
        <div className="lead-main">
          {gated && (
            <section className="card tone-warning">
              <div className="card-head">
                <h2>Gate: {d.gate.status.replace(/_/g, " ")}</h2>
                {lead.gateApproved && (
                  <Badge tone="success" icon="check">
                    approved by you
                  </Badge>
                )}
              </div>
              {d.gate.reasons.length > 0 && (
                <ul className="small">
                  {d.gate.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              {!lead.gateApproved ? (
                <div style={{ marginTop: 12 }}>
                  <ReasonForm
                    label="Approve this lead anyway (no sequence is written until you do)"
                    button="Approve lead"
                    onSubmit={async (reason) => setData(await api<LeadDetail>(`/leads/${lead.id}/gate-override`, { method: "POST", body: { reason } }))}
                  />
                </div>
              ) : (
                <p className="small muted" style={{ marginTop: 8 }}>
                  You approved this lead. The reason is in the log below.
                </p>
              )}
            </section>
          )}

          <ContactCard lead={lead} onChange={setData} reload={reload} />

          <section className="card">
            <div className="card-head">
              <h2>Facts</h2>
              <span className="sub">Each fact has a source and a quote, or is NOT_FOUND.</span>
            </div>
            <table className="kv facts">
              <tbody>
                {FIELDS.map(([key, label]) => (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td>
                      <FieldValue value={(d as unknown as Record<string, unknown>)[key]} />
                    </td>
                  </tr>
                ))}
                <tr>
                  <th scope="row">US location (code)</th>
                  <td>
                    {show(d.us_location.value)} <span className="muted small">({d.us_location.reason})</span>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Target industry fit (code)</th>
                  <td>
                    {show(d.target_industry_fit.value)} <span className="muted small">({d.target_industry_fit.reason})</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>DNS</h2>
              <span className="sub">Passive lookups only. DKIM is never checked.</span>
            </div>
            <table className="kv">
              <tbody>
                {Object.entries(d.dns).map(([k, v]) => (
                  <tr key={k}>
                    <th scope="row">{k.replace(/_/g, " ")}</th>
                    <td>
                      {v === "NOT_CHECKED" ? (
                        <Badge mono title="Never checked or claimed">
                          NOT_CHECKED
                        </Badge>
                      ) : (
                        <FieldValue value={v} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="card">
            <h2 style={{ marginBottom: 12 }}>Pages</h2>
            <div className="two-col">
              <div className="stack-sm">
                <h3>Fetched ({d.pages_opened.length})</h3>
                <ul className="url-list">
                  {d.pages_opened.map((u) => (
                    <li key={u}>
                      <a href={u} target="_blank" rel="noreferrer noopener">
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="stack-sm">
                <h3>Failed or skipped ({d.failures.length})</h3>
                {d.failures.length === 0 ? (
                  <p className="small muted">None.</p>
                ) : (
                  <ul className="url-list muted">
                    {d.failures.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>

          {lead.events.length > 0 && (
            <section className="card">
              <h2 style={{ marginBottom: 8 }}>Log</h2>
              <ul className="log-list">
                {lead.events.map((e, i) => (
                  <li key={i}>
                    <time>{e.createdAt.slice(0, 16).replace("T", " ")}</time>
                    <span>
                      <strong>{e.kind.replace(/_/g, " ")}:</strong> {e.detail}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <aside className="lead-side">
          <Scorecard lead={lead} />
          <section className="card tone-muted">
            <div className="card-head">
              <h2 className="row">
                <Icon name="lock" />
                Internal notes: never used in emails
              </h2>
            </div>
            <dl className="notes">
              <div>
                <dt>Incomplete data</dt>
                <dd>{lead.internalNotes.incompleteData ?? "No: the tier reflects findings, not missing data."}</dd>
              </div>
              <div>
                <dt>Email security hint</dt>
                <dd>{lead.internalNotes.emailSecurityHint ?? "None found."}</dd>
              </div>
              <div>
                <dt>Clients served (not scored)</dt>
                <dd>{lead.internalNotes.clientCount ?? "Not stated."}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </section>
  );
}
