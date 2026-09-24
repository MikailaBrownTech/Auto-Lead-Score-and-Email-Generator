import { useEffect, useState } from "react";
import type { OfferSettingsView, SuppressionView } from "@clearpath/shared";
import { api, useApi } from "../api";
import { ErrorBanner, NoticeBanner } from "../components/ErrorBanner";
import { Badge, EmptyState, PageSkeleton } from "../components/ui";

type SettingsData = { offer: OfferSettingsView; suppressions: SuppressionView[] };

const TEXT_FIELDS: [keyof OfferSettingsView, string][] = [
  ["sender_name", "Sender name"],
  ["sender_title", "Title"],
  ["company_name", "Company name"],
  ["company_website", "Company website"],
  ["opt_out_line", "Opt-out line"],
  ["physical_address", "Mailing address"],
];

/** docs/09 merge fields filled from docs/01 (emails show the {{placeholder}} until set). */
const MERGE_FIELDS: [keyof OfferSettingsView, string, string, boolean][] = [
  ["founding_client_offer", "Founding-client offer", "{{offer}} in email 4, e.g. half off the first three months. Export is blocked while empty.", true],
  ["booking_link", "Booking link", "{{booking_link}} in email 4: your calendar link, the only link an email may contain. Export is blocked while empty.", true],
  ["region", "Region", '{{region}} in email 4 and its subject, as it reads in a sentence, e.g. "Cleveland-area". Export is blocked while empty.', true],
  ["company_one_liner", "Company one-liner", "{{company_one_liner}}, for a template that uses it. Optional unless a template uses it.", false],
];

export function SettingsPage() {
  const { data, error, setData } = useApi<SettingsData>("/settings");
  const [form, setForm] = useState<OfferSettingsView | null>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  useEffect(() => {
    if (data && !form) setForm(data.offer);
  }, [data, form]);
  if (error) return <ErrorBanner message={error} />;
  if (!data || !form) return <PageSkeleton />;

  const set = <K extends keyof OfferSettingsView>(k: K, v: OfferSettingsView[K]) => setForm({ ...form, [k]: v });

  async function save() {
    setSaving(true);
    setNote(null);
    setProblem(null);
    try {
      const saved = await api<SettingsData>("/settings/offer", { method: "PUT", body: form });
      setData(saved);
      setForm(saved.offer);
      setNote("Saved to docs/01. The previous version was backed up in data/backups.");
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function suppressions(fn: () => Promise<SuppressionView[]>) {
    setProblem(null);
    try {
      setData({ ...data!, suppressions: await fn() });
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Saved to docs/01 (the offer block), with a backup of the previous version.</p>
        </div>
      </div>
      <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />
      <section className="card stack">
        <div>
          <h2>Signature and footer</h2>
          <p className="small muted">Every email ends with these. Export stays blocked until all of them are filled in.</p>
        </div>
        <div className="form-grid">
          {TEXT_FIELDS.map(([k, label]) => (
            <label key={k} className={`field${k === "opt_out_line" || k === "physical_address" ? " span-2" : ""}`}>
              <span className="field-label">
                {label} {(form[k] as string).trim() === "" && <Badge tone="warning">empty</Badge>}
              </span>
              <input value={form[k] as string} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
        </div>
        <hr style={{ margin: 0 }} />
        <div>
          <h2>Merge fields in the emails</h2>
          <p className="small muted">The copy lives in docs/09_sequences.md. These values fill its {"{{...}}"} fields when an email is shown or exported, so changes apply to every sequence without writing it again.</p>
        </div>
        <div className="form-grid">
          {MERGE_FIELDS.map(([k, label, hint, required]) => (
            <label key={k} className={`field${k === "founding_client_offer" || k === "company_one_liner" ? " span-2" : ""}`}>
              <span className="field-label">
                {label} {required && (form[k] as string).trim() === "" && <Badge tone="warning">empty</Badge>}
              </span>
              <input value={form[k] as string} onChange={(e) => set(k, e.target.value)} />
              <span className="field-hint">{hint}</span>
            </label>
          ))}
          <label className="check span-2">
            <input type="checkbox" checked={form.checklist_ready} onChange={(e) => set("checklist_ready", e.target.checked)} /> The checklist is ready to send
          </label>
          <label className="check span-2">
            <input type="checkbox" checked={form.include_dns_observation} onChange={(e) => set("include_dns_observation", e.target.checked)} /> Allow one hedged DNS remark (for example DMARC set to monitoring only)
          </label>
        </div>
        <div className="row">
          <button type="button" className="btn primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
        {note && <NoticeBanner tone="success">{note}</NoticeBanner>}
      </section>

      <section className="card stack">
        <div>
          <h2>Suppression list</h2>
          <p className="small muted">An email address or a whole domain. Checked before every export row.</p>
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void suppressions(() => api<SuppressionView[]>("/suppressions", { method: "POST", body: { value: newValue } })).then(() => setNewValue(""));
          }}
        >
          <div className="grow" style={{ maxWidth: 360 }}>
            <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="jane@firm.com or firm.com" aria-label="Email or domain to suppress" />
          </div>
          <button type="submit" className="btn secondary" disabled={!newValue.trim()}>
            Add
          </button>
        </form>
        {data.suppressions.length === 0 ? (
          <EmptyState title="Nobody is suppressed yet">Add an address or domain when someone asks not to be emailed.</EmptyState>
        ) : (
          <ul className="suppressions">
            {data.suppressions.map((s) => (
              <li key={s.id}>
                <span>
                  {s.value} <Badge>{s.kind}</Badge>
                </span>
                <button type="button" className="btn ghost sm" onClick={() => void suppressions(() => api<SuppressionView[]>(`/suppressions/${s.id}`, { method: "DELETE" }))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
