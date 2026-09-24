import { useEffect, useState } from "react";
import type { OfferSettingsView, SuppressionView } from "@clearpath/shared";
import { api, useApi } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";

type SettingsData = { offer: OfferSettingsView; suppressions: SuppressionView[] };

const TEXT_FIELDS: [keyof OfferSettingsView, string][] = [
  ["sender_name", "Sender name"],
  ["sender_title", "Title"],
  ["company_name", "Company name"],
  ["company_website", "Company website"],
  ["opt_out_line", "Opt-out line"],
  ["physical_address", "Mailing address"],
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
  if (!data || !form) return <p className="muted">Loading…</p>;

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
    <section>
      <h2>Settings</h2>
      <div className="card">
        <h3>Signature and footer</h3>
        <p className="muted">Every email ends with these. Export stays blocked until all of them are filled in.</p>
        {TEXT_FIELDS.map(([k, label]) => (
          <label key={k}>
            {label}
            <input value={form[k] as string} onChange={(e) => set(k, e.target.value)} />
          </label>
        ))}
        <label>
          Email 3 offers
          <select value={form.cta_type} onChange={(e) => set("cta_type", e.target.value as OfferSettingsView["cta_type"])}>
            <option value="checklist">the one-page checklist</option>
            <option value="scorecard">the 2-minute scorecard (only once it exists)</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.checklist_ready} onChange={(e) => set("checklist_ready", e.target.checked)} /> The checklist is ready to send
        </label>
        <label className="check">
          <input type="checkbox" checked={form.include_dns_observation} onChange={(e) => set("include_dns_observation", e.target.checked)} /> Allow one hedged DNS remark (for example DMARC set to monitoring only)
        </label>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </button>
        {note && <p className="ok">{note}</p>}
      </div>

      <div className="card">
        <h3>Suppression list</h3>
        <p className="muted">An email address or a whole domain. Checked before every export row.</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void suppressions(() => api<SuppressionView[]>("/suppressions", { method: "POST", body: { value: newValue } })).then(() => setNewValue(""));
          }}
        >
          <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="jane@firm.com or firm.com" aria-label="Email or domain to suppress" />
          <button type="submit" disabled={!newValue.trim()}>
            Add
          </button>
        </form>
        {data.suppressions.length === 0 ? (
          <p className="muted">Nobody is suppressed yet.</p>
        ) : (
          <ul className="plain">
            {data.suppressions.map((s) => (
              <li key={s.id} className="row">
                <span>
                  {s.value} <span className="muted">({s.kind})</span>
                </span>
                <button type="button" className="link" onClick={() => void suppressions(() => api<SuppressionView[]>(`/suppressions/${s.id}`, { method: "DELETE" }))}>
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <ErrorBanner message={problem} onDismiss={() => setProblem(null)} />
    </section>
  );
}
