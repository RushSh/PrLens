import type { TriageEvaluation } from "@prlens/shared";

/**
 * Lines read (x) against bugs skipped (y), one point per skip threshold, with the chosen threshold marked and
 * the miss bound drawn. Plain SVG so it themes with the page.
 */
export function EvalChart({ ev, chosen, prs }: { ev: TriageEvaluation; chosen: { read: number; missed: number }; prs: number }) {
  const W = 640, H = 320, L = 52, R = 16, T = 16, B = 44;
  const x = (v: number) => L + v * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const pts = [...ev.sweep].sort((a, b) => a.read_share - b.read_share).map((s) => [s.read_share, s.missed / prs] as const);
  const path = pts.map(([a, b], i) => `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto h-auto w-full max-w-3xl" role="img"
      aria-label="Share of PRs whose bug was skipped, against the share of lines a reviewer reads">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(0)} x2={x(1)} y1={y(t)} y2={y(t)} stroke="var(--gh-line-muted)" />
          <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--gh-muted)">{Math.round(t * 100)}%</text>
          <text x={x(t)} y={H - B + 18} textAnchor="middle" fontSize="11" fill="var(--gh-muted)">{Math.round(t * 100)}%</text>
        </g>
      ))}
      <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--gh-muted)">lines a reviewer reads</text>
      <text x={14} y={(T + H - B) / 2} textAnchor="middle" fontSize="12" fill="var(--gh-muted)" transform={`rotate(-90 14 ${(T + H - B) / 2})`}>
        PRs whose bug was skipped
      </text>
      {/* skipping at random: a bug is skipped about as often as its lines are */}
      <line x1={x(0)} y1={y(1)} x2={x(1)} y2={y(0)} stroke="var(--gh-muted)" strokeDasharray="4 4" />
      <text x={x(0.62)} y={y(0.44)} fontSize="11" fill="var(--gh-muted)">skipping at random (approx.)</text>
      {/* the promised bound */}
      <line x1={x(0)} x2={x(1)} y1={y(ev.alpha)} y2={y(ev.alpha)} stroke="var(--gh-attention)" strokeDasharray="2 3" />
      <text x={x(1) - 4} y={y(ev.alpha) - 6} textAnchor="end" fontSize="11" fill="var(--gh-attention)">bound {Math.round(ev.alpha * 100)}%</text>
      <path d={path} fill="none" stroke="var(--gh-accent)" strokeWidth="2.5" />
      <circle cx={x(chosen.read)} cy={y(chosen.missed / prs)} r="5" fill="var(--gh-success-emph)" stroke="var(--gh-canvas)" strokeWidth="2" />
      <text x={x(chosen.read) + 10} y={y(chosen.missed / prs) + 20} fontSize="12" fontWeight="600" fill="var(--gh-fg)">
        PR Lens: read {Math.round(chosen.read * 100)}%, skip {chosen.missed} of {prs} bugs
      </text>
    </svg>
  );
}
