import type { Ablation } from "@prlens/shared";
import { pct } from "@/lib/format";

/**
 * Does the model earn its place? Each ranking at the same miss target (held out by repository), and each at PR
 * Lens's own reading budget, plus how well the risk score matches observed bug rates.
 */
export function AblationPanel({ ab, label }: { ab: Ablation; label: string }) {
  const rows = ab.rows;
  const lens = rows.find((r) => r.key === "combined");
  const code = rows.find((r) => r.key === "code features");
  const spark = rows.find((r) => r.key === "spark open");
  const saved = lens && code ? code.held_out_read_share - lens.held_out_read_share : null;
  return (
    <div className="space-y-5 p-4">
      <p className="max-w-3xl text-sm text-fg">
        Every ranking below is held to the same target (at most {pct(ab.alpha)} of bugs skipped, 90% bound), out of fold and
        with the threshold chosen without each repository. The question is how much each one lets a reviewer skip.
        {lens && code && saved !== null ? (
          <>
            {" "}In {label}, adding Spark Open to the code features takes reading from{" "}
            <span className="font-semibold">{pct(code.held_out_read_share)}</span> to{" "}
            <span className="font-semibold">{pct(lens.held_out_read_share)}</span> of lines
            {saved > 0.005 ? <> ({Math.round(saved * 100)} points less)</> : <> (no measurable saving here)</>}; Spark Open on its own
            reads {spark ? pct(spark.held_out_read_share) : "—"}.
          </>
        ) : null}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-2 pr-4 font-medium">Ranking</th>
              <th className="py-2 pr-4 text-right font-medium">AUC</th>
              <th className="w-[40%] py-2 pr-4 font-medium">Lines left to read at the target (held out)</th>
              <th className="py-2 text-right font-medium">Bugs kept at PR Lens&apos;s budget ({pct(ab.budget)})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isLens = r.key === "combined";
              const muted = r.key === "with-must-review";
              return (
                <tr key={r.key} className={`border-b border-line-muted last:border-b-0 ${muted ? "text-muted" : ""}`}>
                  <td className={`py-2 pr-4 ${isLens ? "font-semibold text-fg" : ""}`}>{r.label}</td>
                  <td className="tabular py-2 pr-4 text-right">{r.key === "random" ? "0.50" : r.auc.toFixed(2)}</td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <div className="h-2.5 flex-1 rounded-full bg-line-muted" aria-hidden>
                        <div
                          className={`h-2.5 rounded-full ${isLens ? "bg-accent" : "bg-muted/60"}`}
                          style={{ width: `${Math.min(1, r.held_out_read_share) * 100}%` }}
                        />
                      </div>
                      <span className="tabular w-10 text-right">{pct(r.held_out_read_share)}</span>
                    </div>
                  </td>
                  <td className="tabular py-2 text-right">
                    {r.key === "random" ? r.kept_at_budget.toFixed(1) : r.kept_at_budget} of {ab.prs}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <CalibrationChart rel={ab.reliability} />
        <div className="space-y-3 text-sm text-fg">
          <p>
            <span className="font-semibold">Is the risk score a probability?</span> Regions are split into ten equal groups by
            score; each point compares the group&apos;s average score with the share that held a bug. Points on the diagonal mean
            the score can be read as a probability.
          </p>
          <p className="text-muted">
            Average gap (ECE) {pct(ab.reliability.ece, 1)}; Brier score {ab.reliability.brier.toFixed(3)} against{" "}
            {ab.reliability.brier_base_rate.toFixed(3)} for always guessing the base rate of {pct(ab.reliability.base_rate, 1)};{" "}
            {ab.reliability.regions.toLocaleString()} regions.
          </p>
          <p className="text-muted">
            <span className="font-semibold text-fg">Clustering check.</span> Resampling whole repositories ({ab.bootstrap.repos} of
            them, {ab.bootstrap.draws.toLocaleString()} draws), the miss rate at the chosen threshold has a 90th percentile of{" "}
            {pct(ab.bootstrap.p90, 1)}, beside the Clopper-Pearson bound of {pct(ab.bootstrap.clopper_pearson_90, 1)}. With this
            few repositories it is a rough check, not a second guarantee.
          </p>
        </div>
      </div>
    </div>
  );
}

function CalibrationChart({ rel }: { rel: Ablation["reliability"] }) {
  const W = 420, H = 300, L = 48, R = 12, T = 12, B = 42;
  const top = Math.max(0.3, ...rel.bins.map((b) => Math.max(b.mean_score, b.bug_rate))) * 1.05;
  const x = (v: number) => L + (v / top) * (W - L - R);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const ticks = [0, 0.1, 0.2, 0.3, 0.4, 0.5].filter((t) => t <= top);
  const path = rel.bins.map((b, i) => `${i ? "L" : "M"}${x(b.mean_score).toFixed(1)},${y(b.bug_rate).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-xl" role="img" aria-label="Risk score against observed bug rate">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(0)} x2={x(top)} y1={y(t)} y2={y(t)} stroke="var(--gh-line-muted)" />
          <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--gh-muted)">{Math.round(t * 100)}%</text>
          <text x={x(t)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="var(--gh-muted)">{Math.round(t * 100)}%</text>
        </g>
      ))}
      <line x1={x(0)} y1={y(0)} x2={x(top)} y2={y(top)} stroke="var(--gh-muted)" strokeDasharray="4 4" />
      <text x={x(top * 0.62)} y={y(top * 0.7)} fontSize="11" fill="var(--gh-muted)">perfectly calibrated</text>
      <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--gh-muted)">average risk score in the group</text>
      <text x={13} y={(T + H - B) / 2} textAnchor="middle" fontSize="12" fill="var(--gh-muted)" transform={`rotate(-90 13 ${(T + H - B) / 2})`}>
        share with a bug
      </text>
      <path d={path} fill="none" stroke="var(--gh-accent)" strokeWidth="2" />
      {rel.bins.map((b, i) => (
        <circle key={i} cx={x(b.mean_score)} cy={y(b.bug_rate)} r={3 + Math.min(4, b.bugs / 4)} fill="var(--gh-accent)" stroke="var(--gh-canvas)" strokeWidth="1.5">
          <title>{`score ${(b.mean_score * 100).toFixed(1)}%: ${b.bugs} of ${b.regions} regions held a bug (${(b.bug_rate * 100).toFixed(1)}%)`}</title>
        </circle>
      ))}
    </svg>
  );
}
