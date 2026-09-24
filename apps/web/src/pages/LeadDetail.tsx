import { useState, type ReactNode } from "react";
import type { JobView, LeadDetail, SequenceView } from "@clearpath/shared";
import { api, useApi, usd } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { ReasonForm } from "../components/ReasonForm";
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

const NotFound = () => <span className="badge notfound">NOT_FOUND</span>;

function Evidence(props: { url: string; quote?: string }) {
  const link = /^https?:\/\//.test(props.url) ? (
    <a href={props.url} target="_blank" rel="noreferrer noopener">
      open page
    </a>
  ) : (
    <span className="muted">{props.url === "pasted" ? "pasted text" : props.url}</span>
  );
  return (
    <div className="evidence">
      {link}
      {props.quote && <q>{props.quote}</q>}
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
    .filter(([, x]) => x !== null && x !== undefined)
    .map(([k, x]) => `${k.replace(/_/g, " ")}: ${show(x)}`)
    .join("; ");
}

/** One dossier field: value + evidence link + quote, or a gray NOT_FOUND badge. */
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
          <li key={e.item}>
            {e.item} <Evidence url={e.evidence_url} />
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
      className="card"
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
      <h4>Paste the owner's details</h4>
      <p className="muted">This re-runs the lead in paste mode: only what you paste here is used, so include the About or Services text too.</p>
      <div className="row">
        <label>
          Owner's name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Owner's email
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" />
        </label>
      </div>
      <label>
        Page text
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
      </label>
      <button type="submit" disabled={!!jobId && !finished}>
        Re-run with pasted text
      </button>
      <ErrorBanner message={error} />
      {job && <JobStatus job={job} />}
      {finished && (
        <button type="button" className="secondary" onClick={props.onDone}>
          Show the updated lead
        </button>
      )}
    </form>
  );
}

export function LeadDetailPage(props: { id: string }) {
  const { data: lead, error, reload, setData } = useApi<LeadDetail>(`/leads/${encodeURIComponent(props.id)}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (error) return <ErrorBanner message={error} />;
  if (!lead) return <p className="muted">Loading…</p>;
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
    <section>
      <p>
        <a href={href("leads")}>← Leads</a>
      </p>
      <div className="row between">
        <div>
          <h2>{d.firm_name !== "NOT_FOUND" ? d.firm_name.value : lead.id}</h2>
          <p className="muted">
            {lead.inputUrl ?? "pasted text"} · status {lead.status.replace(/_/g, " ")} · spent {usd(lead.costUsd)}
          </p>
          <Flags flags={lead.flags} />
        </div>
        <div className="score-box">
          <div className="score">{lead.score}</div>
          <div>
            Tier {lead.tier}
            {lead.tierCapped && " (capped by fit)"}
          </div>
        </div>
      </div>

      <div className="row">
        {lead.sequenceId && (
          <a className="button" href={href("sequences", lead.sequenceId)}>
            Open sequence ({lead.sequenceStatus})
          </a>
        )}
        <button type="button" onClick={writeSequence} disabled={busy || !!lead.notWrittenReason}>
          {busy ? "Writing… (about 10-30 seconds)" : lead.sequenceId ? "Write the sequence again" : "Write sequence"}
        </button>
        {lead.tier === "C" && !lead.notWrittenReason && <span className="muted">Tier C: template emails, no model call.</span>}
      </div>
      {/* Why nothing was (or can be) written, always in words next to the button. */}
      {lead.notWrittenReason && <NoticeBanner>{lead.notWrittenReason} (See the gate box below.)</NoticeBanner>}
      {lead.lastWriteAttempt && (
        <NoticeBanner>
          Last write attempt ({lead.lastWriteAttempt.at.slice(0, 16).replace("T", " ")}): {lead.lastWriteAttempt.detail}
        </NoticeBanner>
      )}
      <ErrorBanner message={actionError} onDismiss={() => setActionError(null)} />

      <div className={`card gate gate-${d.gate.status}`}>
        <h3>Gate: {d.gate.status.replace(/_/g, " ")}</h3>
        {d.gate.reasons.length > 0 && (
          <ul>
            {d.gate.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
        {gated && !lead.gateApproved && (
          <ReasonForm
            label="Approve this lead anyway (no sequence is written until you do)"
            button="Approve lead"
            onSubmit={async (reason) => setData(await api<LeadDetail>(`/leads/${lead.id}/gate-override`, { method: "POST", body: { reason } }))}
          />
        )}
        {gated && lead.gateApproved && <p className="ok">You approved this lead. The reason is in the log below.</p>}
      </div>

      {(lead.directContact.needed || d.declined_automated_access) && (
        <div className="card attention">
          <h3>{lead.directContact.needed ? "Needs a direct contact" : "The website declined automated access"}</h3>
          {lead.directContact.reason && <p>{lead.directContact.reason}. Approval and export stay blocked until this is resolved.</p>}
          {d.declined_automated_access && <p>The site answered HTTP 403/429, so no more pages were requested. Paste the About, Team, or Contact text.</p>}
          <ul className="plain checklist">
            {lead.directContact.checklist.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <PasteForm leadId={lead.id} onDone={reload} />
          {lead.directContact.needed && (
            <ReasonForm
              label="Or override for this lead (for a solo practice whose only address is the owner's inbox). Emails then use the neutral greeting."
              button="Override"
              onSubmit={async (reason) => setData(await api<LeadDetail>(`/leads/${lead.id}/override-contact`, { method: "POST", body: { reason } }))}
            />
          )}
        </div>
      )}
      {lead.directContact.override && (
        <p className="ok">
          Direct contact overridden: “{lead.directContact.override.reason}”. Emails use the neutral greeting.
        </p>
      )}

      <h3>Facts</h3>
      <table className="facts">
        <tbody>
          {FIELDS.map(([key, label]) => (
            <tr key={key}>
              <th>{label}</th>
              <td>
                <FieldValue value={(d as unknown as Record<string, unknown>)[key]} />
              </td>
            </tr>
          ))}
          <tr>
            <th>US location (code)</th>
            <td>
              {show(d.us_location.value)} <span className="muted">({d.us_location.reason})</span>
            </td>
          </tr>
          <tr>
            <th>Target industry fit (code)</th>
            <td>
              {show(d.target_industry_fit.value)} <span className="muted">({d.target_industry_fit.reason})</span>
            </td>
          </tr>
        </tbody>
      </table>

      <h3>DNS (passive lookups)</h3>
      <table className="facts">
        <tbody>
          {Object.entries(d.dns).map(([k, v]) => (
            <tr key={k}>
              <th>{k.replace(/_/g, " ")}</th>
              <td>{v === "NOT_CHECKED" ? <span className="badge notfound">NOT_CHECKED</span> : <FieldValue value={v} />}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Score breakdown</h3>
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Points</th>
            <th>Why</th>
          </tr>
        </thead>
        <tbody>
          {lead.breakdown.map((b) => (
            <tr key={b.key}>
              <td>
                {b.label} <span className="muted">({b.group})</span>
              </td>
              <td>
                {b.points} / {b.max}
              </td>
              <td>{b.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Pages</h3>
      <div className="row top">
        <div>
          <h4>Fetched ({d.pages_opened.length})</h4>
          <ul className="plain">
            {d.pages_opened.map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noreferrer noopener">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Failed or skipped ({d.failures.length})</h4>
          <ul className="plain small">
            {d.failures.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      </div>

      <div className="card internal">
        <h3>Internal notes: never used in emails</h3>
        <dl>
          <dt>Incomplete data</dt>
          <dd>{lead.internalNotes.incompleteData ?? "No: the tier reflects findings, not missing data."}</dd>
          <dt>Email security hint</dt>
          <dd>{lead.internalNotes.emailSecurityHint ?? "None found."}</dd>
          <dt>Clients served (not scored)</dt>
          <dd>{lead.internalNotes.clientCount ?? "Not stated."}</dd>
        </dl>
      </div>

      {lead.events.length > 0 && (
        <>
          <h3>Log</h3>
          <ul className="plain small">
            {lead.events.map((e, i) => (
              <li key={i}>
                {e.createdAt.slice(0, 16).replace("T", " ")} · {e.kind.replace(/_/g, " ")}: {e.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
