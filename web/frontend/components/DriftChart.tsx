"use client";

import { useState } from "react";
import type { DriftReplay, TriageEvaluation } from "@prlens/shared";
import { pct } from "@/lib/format";

const ORDERS = [
  { key: "shift", label: "Hardest repositories last" },
  { key: "date", label: "In date order" },
] as const;

/**
 * Cumulative miss rate as PRs arrive, for the fixed threshold (calibrated once) and the adaptive one, with the target
 * and the ceiling the adaptive threshold is proven never to exceed.
 */
export function DriftChart({ drift }: { drift: NonNullable<TriageEvaluation["drift"]> }) {
  const [order, setOrder] = useState<(typeof ORDERS)[number]["key"]>("shift");
  const r: DriftReplay = drift[order];
  const W = 640, H = 300, L = 48, R = 16, T = 14, B = 40;
  const YMAX = 0.6;
  const n = r.prs;
  const x = (i: number) => L + (i / Math.max(1, n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(v, YMAX) / YMAX) * (H - T - B);
  const line = (vals: number[]) => vals.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const ticks = [0, 0.2, 0.4, 0.6];
  const last = (a: number[]) => a[a.length - 1] ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Order the PRs arrive in">
        {ORDERS.map((o) => (
          <button
            key={o.key}
            type="button"
            role="tab"
            aria-selected={order === o.key}
            onClick={() => setOrder(o.key)}
            className={`rounded-full border px-3 py-1 text-sm ${order === o.key ? "border-accent bg-accent-subtle font-semibold text-accent" : "border-line text-muted hover:text-fg"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto h-auto w-full max-w-3xl" role="img"
        aria-label="Share of PRs whose bug was skipped so far, fixed vs adaptive threshold">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--gh-line-muted)" />
            <text x={L - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--gh-muted)">{Math.round(t * 100)}%</text>
          </g>
        ))}
        {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
          <text key={i} x={x(i)} y={H - B + 18} textAnchor="middle" fontSize="11" fill="var(--gh-muted)">{i + 1}</text>
        ))}
        <text x={(L + W - R) / 2} y={H - 6} textAnchor="middle" fontSize="12" fill="var(--gh-muted)">PRs reviewed (after {r.warm} to set the start)</text>
        <path d={line(r.bound)} fill="none" stroke="var(--gh-muted)" strokeDasharray="2 4" strokeWidth="1.5" />
        <line x1={L} x2={W - R} y1={y(r.alpha)} y2={y(r.alpha)} stroke="var(--gh-attention)" strokeDasharray="5 4" />
        <path d={line(r.fixed)} fill="none" stroke="var(--gh-danger)" strokeWidth="2.5" />
        <path d={line(r.adaptive)} fill="none" stroke="var(--gh-accent)" strokeWidth="2.5" />
        <text x={W - R - 4} y={y(last(r.fixed)) - 7} textAnchor="end" fontSize="12" fontWeight="600" fill="var(--gh-danger)">
          fixed threshold {pct(last(r.fixed))}
        </text>
        <text x={W - R - 4} y={y(last(r.adaptive)) + 16} textAnchor="end" fontSize="12" fontWeight="600" fill="var(--gh-accent)">
          adaptive {pct(last(r.adaptive))}
        </text>
        <text x={L + 6} y={y(r.alpha) - 6} fontSize="11" fill="var(--gh-attention)">target {pct(r.alpha)}</text>
        <text x={x(Math.min(n - 1, 6))} y={y(Math.min(YMAX, r.bound[6] ?? YMAX)) + 2} dx="8" fontSize="11" fill="var(--gh-muted)">
          proven ceiling
        </text>
      </svg>
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <Figure label="Fixed threshold" tone="text-danger" missed={r.missed.fixed} n={n} read={r.read_share.fixed} />
        <Figure label="Adaptive threshold" tone="text-accent" missed={r.missed.adaptive} n={n} read={r.read_share.adaptive} />
        <div className="rounded-md border border-line p-3">
          <div className="text-xs text-muted">200 random orders (no drift)</div>
          <div className="mt-1 text-fg">
            fixed misses {pct(drift.random.fixed.mean)}, reads {pct(drift.random.read_fixed.mean)}
          </div>
          <div className="text-fg">
            adaptive misses {pct(drift.random.adaptive.mean)}, reads <span className="font-semibold">{pct(drift.random.read_adaptive.mean)}</span>
          </div>
          <div className="text-xs text-muted">worst tenth of orders: adaptive {pct(drift.random.adaptive.p90)}</div>
        </div>
      </div>
    </div>
  );
}

function Figure({ label, tone, missed, n, read }: { label: string; tone: string; missed: number; n: number; read: number }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className={`text-xs font-semibold ${tone}`}>{label}</div>
      <div className="tabular mt-1 text-lg font-semibold text-fg">
        {missed} / {n} bugs skipped <span className="text-sm font-normal text-muted">({pct(missed / n)})</span>
      </div>
      <div className="text-xs text-muted">reads {pct(read)} of lines</div>
    </div>
  );
}
