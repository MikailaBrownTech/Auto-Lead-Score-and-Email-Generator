import { useEffect, useState } from "react";
import { SpendSummarySchema, type SpendSummary } from "@clearpath/shared";

export function SpendMeter() {
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/spend");
        if (!res.ok) throw new Error(`API returned ${res.status}`);
        const data = SpendSummarySchema.parse(await res.json());
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

  if (error) return <div className="spend spend-error">Spend: unavailable ({error})</div>;
  if (!spend) return <div className="spend">Spend: loading…</div>;

  const pct = Math.min(100, ((spend.spentUsd + spend.reservedUsd) / spend.capUsd) * 100);
  const level = pct >= 90 ? "high" : pct >= 70 ? "mid" : "low";
  return (
    <div className="spend" title={`Month ${spend.month} (UTC)`}>
      <span>
        ${spend.spentUsd.toFixed(2)} of ${spend.capUsd.toFixed(2)} this month
        {spend.reservedUsd > 0 && ` (+$${spend.reservedUsd.toFixed(2)} in flight)`}
      </span>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <div className={`meter-fill meter-${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
