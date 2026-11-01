"use client";

import { useState } from "react";
import type { DialRow } from "@prlens/shared";
import { pct } from "@/lib/format";

/**
 * The miss target as a dial. Each stop is precomputed on the frozen evaluation scores: the threshold PR Lens would
 * pick for that target, the reading it saves and the misses it risks, held out by repository. A second slider shows
 * what the target means if bugs in skipped code are found less often than bugs a reviewer reads.
 */
export function MissDial({ rows, prs, defaultAlpha, label }: { rows: DialRow[]; prs: number; defaultAlpha: number; label: string }) {
  const start = Math.max(0, rows.findIndex((r) => Math.abs(r.alpha - defaultAlpha) < 1e-9));
  const [i, setI] = useState(start);
  const [q, setQ] = useState(1);
  const r = rows[i]!;
  const truth = r.alpha / (r.alpha + (1 - r.alpha) * q);
  const over = r.held_out_bound > r.alpha + 0.005;

  // the frontier: lines left to read (held out) against the target
  const W = 360, H = 150, L = 36, R = 8, T = 8, B = 26;
  const a0 = rows[0]!.alpha, a1 = rows[rows.length - 1]!.alpha;
  const x = (a: number) => L + ((a - a0) / (a1 - a0)) * (W - L - R);
  const y = (v: number) => T + (1 - v) * (H - T - B);
  const path = rows.map((d, k) => `${k ? "L" : "M"}${x(d.alpha).toFixed(1)},${y(d.held_out_read_share).toFixed(1)}`).join(" ");

  return (
    <div className="grid gap-6 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <label className="block">
          <span className="flex items-baseline justify-between text-sm">
            <span className="font-semibold text-fg">Miss target</span>
            <span className="tabular text-2xl font-semibold text-fg">{pct(r.alpha, 1)}</span>
          </span>
          <input
            type="range"
            min={0}
            max={rows.length - 1}
            step={1}
            value={i}
            onChange={(e) => setI(Number(e.target.value))}
            className="mt-2 w-full accent-[var(--gh-accent)]"
            aria-label="Miss target"
          />
          <span className="relative block h-4 text-xs text-muted">
            <span className="absolute left-0">{pct(a0)} · read more</span>
            <span
              className="absolute -translate-x-1/2 whitespace-nowrap"
              style={{ left: `${(start / Math.max(1, rows.length - 1)) * 100}%` }}
            >
              ▲ default {pct(defaultAlpha)}
            </span>
            <span className="absolute right-0">read less · {pct(a1)}</span>
          </span>
        </label>

        {r.threshold === 0 ? (
          <p className="rounded-md border border-attention/40 bg-attention-subtle px-3 py-2 text-sm text-fg">
            No score threshold meets this target on {label}: everything except the no-model skips is read.
          </p>
        ) : null}

        <div className="grid grid-cols-3 gap-3">
          <Readout label="Lines left to read" value={pct(r.held_out_read_share)} sub="held out by repository" />
          <Readout
            label="Bugs in skipped code"
            value={`${r.held_out_missed} / ${prs}`}
            sub={`${pct(r.held_out_missed / prs, 1)}; 90% bound ${pct(r.held_out_bound, 1)}`}
            warn={over}
          />
          <Readout label="Repository bootstrap" value={pct(r.bootstrap_p90, 1)} sub="90th-percentile miss rate" warn={r.bootstrap_p90 > r.alpha + 0.005} />
        </div>
        {over ? (
          <p className="text-xs text-muted">
            Held out by repository, the 90% upper bound sits above the target here: a threshold chosen without a repository does
            not carry over to it exactly, and {prs} PRs cannot pin the rate tighter. The target is a dial, not a guarantee.
          </p>
        ) : null}

        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-md" role="img" aria-label="Lines left to read at each miss target">
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--gh-line-muted)" />
              <text x={L - 5} y={y(t) + 4} textAnchor="end" fontSize="10" fill="var(--gh-muted)">{pct(t)}</text>
            </g>
          ))}
          {[a0, 0.2, a1].map((t) => (
            <text key={t} x={x(t)} y={H - 8} textAnchor="middle" fontSize="10" fill="var(--gh-muted)">{pct(t)}</text>
          ))}
          <path d={path} fill="none" stroke="var(--gh-accent)" strokeWidth="2" />
          <line x1={x(r.alpha)} x2={x(r.alpha)} y1={T} y2={H - B} stroke="var(--gh-muted)" strokeDasharray="3 3" />
          <circle cx={x(r.alpha)} cy={y(r.held_out_read_share)} r="5" fill="var(--gh-accent)" stroke="var(--gh-canvas)" strokeWidth="2" />
        </svg>
        <p className="-mt-2 text-xs text-muted">Lines left to read (held out) at each miss target, {label}.</p>
      </div>

      <div className="space-y-3 rounded-md border border-line bg-subtle p-4 text-sm">
        <p className="font-semibold text-fg">What the target means if skipped-code bugs surface late</p>
        <p className="text-muted">
          Online, the threshold only learns from bugs that get found. A bug in code a reviewer read is caught at once; a bug in
          skipped code turns up only if it later breaks something. If skipped-code bugs are found a fraction q as often, an
          observed miss rate understates the true one.
        </p>
        <label className="block">
          <span className="flex items-baseline justify-between">
            <span className="text-fg">q, how often skipped-code bugs are found</span>
            <span className="tabular font-semibold text-fg">{q.toFixed(2)}</span>
          </span>
          <input
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={q}
            onChange={(e) => setQ(Number(e.target.value))}
            className="mt-2 w-full accent-[var(--gh-accent)]"
            aria-label="How often skipped-code bugs are found"
          />
        </label>
        <p className="text-fg">
          An observed {pct(r.alpha, 1)} then means about{" "}
          <span className="tabular text-xl font-semibold">{pct(truth)}</span> of all bugs sit in skipped code.
        </p>
        <p className="text-xs text-muted">
          True share = α / (α + (1 − α)·q), assuming bugs a reviewer reads are always found. A team that finds skipped-code bugs
          late should set the target lower.
        </p>
      </div>
    </div>
  );
}

function Readout({ label, value, sub, warn = false }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className={`tabular text-xl font-semibold ${warn ? "text-attention" : "text-fg"}`}>{value}</div>
      <div className="text-xs text-muted">{sub}</div>
    </div>
  );
}
