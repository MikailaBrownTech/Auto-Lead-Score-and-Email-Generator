import { useMemo, useState } from "react";
import type { LeadRow } from "@clearpath/shared";
import { useApi, usd } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { href } from "../router";

const FLAG_TEXT: Record<keyof LeadRow["flags"], string> = {
  generic_inbox: "generic inbox",
  needs_direct_contact: "needs direct contact",
  incomplete_data: "incomplete data",
  declined_automated_access: "site declined access",
};

type SortKey = "firm" | "score" | "tier" | "status" | "costUsd";

export function Flags(props: { flags: LeadRow["flags"] }) {
  const on = (Object.keys(props.flags) as (keyof LeadRow["flags"])[]).filter((k) => props.flags[k]);
  return (
    <>
      {on.map((k) => (
        <span key={k} className={`badge flag-${k}`}>
          {FLAG_TEXT[k]}
        </span>
      ))}
    </>
  );
}

export function LeadsPage() {
  const { data, error, reload } = useApi<LeadRow[]>("/leads");
  const [tier, setTier] = useState("all");
  const [status, setStatus] = useState("all");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "score", desc: true });
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

  const header = (key: SortKey, label: string) => (
    <th>
      <button type="button" className="link" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "score" || key === "costUsd" }))}>
        {label}
        {sort.key === key ? (sort.desc ? " ▼" : " ▲") : ""}
      </button>
    </th>
  );

  return (
    <section>
      <div className="row between">
        <h2>Leads</h2>
        <button type="button" className="secondary" onClick={reload}>
          Refresh
        </button>
      </div>
      <div className="row">
        <label className="inline">
          Tier{" "}
          <select value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="all">All</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </label>
        <label className="inline">
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ErrorBanner message={error} />
      {data && data.length === 0 && <p className="muted">No leads yet. Start on the Import page.</p>}
      {rows.length > 0 && (
        <table className="leads">
          <thead>
            <tr>
              {header("firm", "Firm")}
              <th>Type</th>
              <th>City / state</th>
              {header("score", "Score")}
              {header("tier", "Tier")}
              {header("status", "Gate / status")}
              <th>Flags</th>
              <th>Sequence</th>
              {header("costUsd", "Cost")}
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id}>
                <td>
                  <a href={href("leads", l.id)}>{l.firm ?? l.id}</a>
                  {l.source === "pasted" && <span className="badge">pasted</span>}
                </td>
                <td>{l.type?.replace(/_/g, " ") ?? "—"}</td>
                <td>{[l.city, l.state].filter(Boolean).join(", ") || "—"}</td>
                <td>{l.score ?? "—"}</td>
                <td>{l.tier ?? "—"}</td>
                <td>
                  {l.gate?.replace(/_/g, " ") ?? "—"} / {l.status.replace(/_/g, " ")}
                </td>
                <td>
                  <Flags flags={l.flags} />
                </td>
                <td>{l.sequenceStatus ?? "—"}</td>
                <td>{usd(l.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
