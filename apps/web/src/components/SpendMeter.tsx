import { useEffect, useState } from "react";
import type { SpendView } from "@clearpath/shared";
import { api, usd } from "../api";

/** Month-to-date spend against the cap, and the average cost per lead. Shown on every page. */
export function SpendMeter() {
  const [spend, setSpend] = useState<SpendView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await api<SpendView>("/spend");
        if (!cancelled) {
          setSpend(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    }
    void load();
    const id = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) return <div className="spend spend-error">Spend unavailable: {error}</div>;
  if (!spend) return <div className="spend">Spend: loading…</div>;

  const pct = Math.min(100, ((spend.spentUsd + spend.reservedUsd) / spend.capUsd) * 100);
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";
  return (
    <div className="spend" title={`Month ${spend.month} (UTC)`}>
      <span>
        {usd(spend.spentUsd)} of {usd(spend.capUsd)} this month
        {spend.reservedUsd > 0 && ` (+${usd(spend.reservedUsd)} in progress)`}
        {spend.leadsWithSpend > 0 && ` · about ${usd(spend.avgPerLeadUsd)} per lead`}
      </span>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className={`meter-fill meter-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
