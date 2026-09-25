import { useMemo, useState } from "react";
import type { DeleteLeadsView, LeadRow } from "@clearpath/shared";
import { api, useApi, usd } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Badge, EmptyState, Icon, Skeleton, StatusBadge, TierChip, type Tone } from "../components/ui";
import { href } from "../router";

/** Contact flags are warnings, never blockers; the words say what they mean. */
const FLAG_TEXT: Record<keyof LeadRow["flags"], [string, Tone]> = {
  generic_inbox: ["generic inbox: lower reply odds", "warning"],
  unattributed_inbox: ["unattributed inbox: lower reply odds", "warning"],
  no_public_email: ["no public email", "warning"],
  incomplete_data: ["incomplete data", "info"],
  declined_automated_access: ["site declined access", "neutral"],
};

type SortKey = "firm" | "score" | "tier" | "status" | "costUsd";

export function Flags(props: { flags: LeadRow["flags"] }) {
  const on = (Object.keys(FLAG_TEXT) as (keyof LeadRow["flags"])[]).filter((k) => props.flags[k]);
  if (on.length === 0) return null;
  return (
    <span className="badges">
      {on.map((k) => (
        <Badge key={k} tone={FLAG_TEXT[k][1]} icon={FLAG_TEXT[k][1] === "warning" ? "alert" : undefined}>
          {FLAG_TEXT[k][0]}
        </Badge>
      ))}
    </span>
  );
}

export function LeadsPage() {
  const { data, error, reload } = useApi<LeadRow[]>("/leads");
  const [tier, setTier] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "score", desc: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const statuses = useMemo(() => [...new Set((data ?? []).map((l) => l.status))].sort(), [data]);

  const rows = useMemo(() => {
    const list = (data ?? []).filter((l) => (tier === "all" || l.tier === tier) && (status === "all" || l.status === status));
    const val = (l: LeadRow) => (sort.key === "firm" ? (l.firm ?? l.id).toLowerCase() : sort.key === "tier" ? (l.tier ?? "Z") : sort.key === "status" ? l.status : (l[sort.key] ?? -1));
    return [...list].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -c : c;
    });
  }, [data, tier, status, sort]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rowIds = rows.map((l) => l.id);
  const allSelected = rowIds.length > 0 && rowIds.every((id) => selected.has(id));
  function toggleAll() {
    setSelected((s) => {
      if (allSelected) {
        const next = new Set(s);
        for (const id of rowIds) next.delete(id);
        return next;
      }
      return new Set([...s, ...rowIds]);
    });
  }

  async function deleteSelected() {
    const ids = [...selected];
    const names = rows.filter((l) => selected.has(l.id)).map((l) => l.firm ?? l.id);
    if (!window.confirm(`Delete ${ids.length} lead${ids.length === 1 ? "" : "s"}?\n\n${names.join("\n")}\n\nThis removes their research, sequences, and logs for good. This cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api<DeleteLeadsView>("/leads/bulk-delete", { method: "POST", body: { ids } });
      setSelected(new Set());
      reload();
    } catch (err) {
      setDeleteError((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const header = (key: SortKey, label: string, num = false) => (
    <th className={num ? "num" : undefined} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button type="button" className="link-button" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "score" || key === "costUsd" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ↓" : " ↑") : ""}
      </button>
    </th>
  );

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="sub">Researched firms, their score and tier, and anything that needs your attention.</p>
        </div>
        <div className="row">
          {selected.size > 0 && (
            <button type="button" className="btn danger" onClick={deleteSelected} disabled={deleting}>
              <Icon name="trash" />
              {deleting ? "Deleting…" : `Delete selected (${selected.size})`}
            </button>
          )}
          <button type="button" className="btn secondary" onClick={reload}>
            <Icon name="refresh" />
            Refresh
          </button>
          <a className="btn primary" href={href("import")}>
            <Icon name="import" />
            Import leads
          </a>
        </div>
      </div>
      <ErrorBanner message={deleteError} onDismiss={() => setDeleteError(null)} />
      <div className="filters">
        <label className="inline-field">
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="all">All tiers</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </label>
        <label className="inline-field">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        {data && (
          <span className="count">
            {rows.length} of {data.length} lead{data.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <ErrorBanner message={error} />
      {!data && !error && (
        <div className="card">
          <Skeleton lines={6} title={false} />
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          icon="leads"
          title="No leads yet"
          action={
            <a className="btn primary" href={href("import")}>
              Import leads
            </a>
          }
        >
          Paste up to 5 website addresses on the Import page. Each site is researched politely and scored here.
        </EmptyState>
      )}
      {data && data.length > 0 && rows.length === 0 && (
        <EmptyState icon="info" title="No leads match these filters">
          Choose "All tiers" and "All statuses" to see every lead.
        </EmptyState>
      )}
      {rows.length > 0 && (
        <div className="table-wrap scroll">
          <table className="data leads">
            <thead>
              <tr>
                <th className="checkbox-col">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all leads" />
                </th>
                {header("firm", "Firm")}
                <th>Type</th>
                <th>Location</th>
                {header("score", "Score", true)}
                {header("tier", "Tier")}
                {header("status", "Status")}
                <th>Flags</th>
                <th>Sequence</th>
                {header("costUsd", "Cost", true)}
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="checkbox-col">
                    <input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.firm ?? l.id}`} />
                  </td>
                  <td className="primary-cell">
                    <a href={href("leads", l.id)}>{l.firm ?? l.id}</a>
                    {l.source === "pasted" && (
                      <>
                        {" "}
                        <Badge>pasted</Badge>
                      </>
                    )}
                  </td>
                  <td className="nowrap">{l.type?.replace(/_/g, " ") ?? "—"}</td>
                  <td className="nowrap">{[l.city, l.state].filter(Boolean).join(", ") || "—"}</td>
                  <td className="num">{l.score ?? "—"}</td>
                  <td>
                    <TierChip tier={l.tier} />
                  </td>
                  <td>
                    <div className="badges">
                      {l.gate && l.gate !== "qualified" && <StatusBadge status={l.gate} />}
                      <StatusBadge status={l.status} />
                    </div>
                  </td>
                  <td>
                    <Flags flags={l.flags} />
                  </td>
                  <td>
                    <StatusBadge status={l.sequenceStatus} />
                  </td>
                  <td className="num">{usd(l.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
