import type { LeadDetail } from "@clearpath/shared";
import { Badge, TierChip } from "./ui";

const GROUPS: [string, string][] = [
  ["fit", "Fit"],
  ["signals", "Signals"],
  ["reachability", "Reachability"],
];

/**
 * Score, tier, and one bar per criterion grouped under Fit, Signals, Reachability. A criterion that
 * scored 0 only because its fact was NOT_FOUND shows as a gray "unknown" bar, never a red zero.
 */
export function Scorecard(props: { lead: Pick<LeadDetail, "score" | "tier" | "tierCapped" | "breakdown"> }) {
  const { lead } = props;
  const max = lead.breakdown.reduce((s, b) => s + b.max, 0);
  const unknown = lead.breakdown.filter((b) => b.dataMissing).length;
  return (
    <section className="card scorecard" aria-label="Scorecard">
      <div className="score-head">
        {/* The one .card-glass hero element on this page: everywhere else is .card (card-dark). */}
        <div className="card-glass score-glass">
          <div className="score-number stat-num">{lead.score}</div>
          <div className="score-of">of {max} points</div>
        </div>
        <div className="tier-block">
          <TierChip tier={lead.tier} large />
          {lead.tierCapped && <Badge tone="warning">capped by fit</Badge>}
        </div>
      </div>
      <div className="score-groups">
      {GROUPS.map(([key, label]) => {
        const items = lead.breakdown.filter((b) => b.group === key);
        if (items.length === 0) return null;
        const pts = items.reduce((s, b) => s + b.points, 0);
        const of = items.reduce((s, b) => s + b.max, 0);
        return (
          <div className="score-group" key={key}>
            <h3>
              {label}
              <span className="pts">
                {pts} / {of}
              </span>
            </h3>
            <ul className="criteria">
              {items.map((b) => (
                <li key={b.key} className={`criterion${b.dataMissing ? " unknown" : b.points === 0 ? " zero" : " earned"}`} title={b.reason}>
                  <span className="label">{b.label}</span>
                  <span className="pts">{b.dataMissing ? "unknown" : `${b.points} / ${b.max}`}</span>
                  <span
                    className="bar"
                    role="meter"
                    aria-label={b.label}
                    aria-valuemin={0}
                    aria-valuemax={b.max}
                    aria-valuenow={b.points}
                    aria-valuetext={b.dataMissing ? "unknown (not found on the site)" : `${b.points} of ${b.max}`}
                  >
                    {!b.dataMissing && <span className="fill" style={{ width: `${b.max ? (b.points / b.max) * 100 : 0}%` }} />}
                  </span>
                  <span className="why">{b.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      </div>
      <div className="score-legend">
        <span>
          <span className="swatch" />
          points earned
        </span>
        <span>
          <span className="swatch unknown" />
          unknown: not found on the site{unknown ? ` (${unknown})` : ""}, not a negative finding
        </span>
      </div>
    </section>
  );
}
