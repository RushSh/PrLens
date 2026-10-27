"use client";

import { useState } from "react";
import type { CalibrationVariant } from "@bugcensus/shared";

// Categorical slots 1 and 2 of the validated reference palette (light surface); text never uses them.
const SERIES = ["#2a78d6", "#eb6834"];
const W = 560;
const H = 380;
const M = { top: 16, right: 24, bottom: 48, left: 52 };

type Point = { v: number; b: CalibrationVariant["bins"][number] };

/**
 * Predicted vs actual hidden bugs per bin (units grouped by predicted value). A calibrated estimator sits on
 * the dashed diagonal. Whiskers are 95% intervals from resampling whole repositories.
 */
export function CalibrationChart({ variants }: { variants: CalibrationVariant[] }) {
  const [hover, setHover] = useState<Point | null>(null);
  const all = variants.flatMap((v) => v.bins.flatMap((b) => [b.pred_mean, b.actual_mean, b.ci_high ?? 0]));
  const max = niceMax(Math.max(0.5, ...all) * 1.08);
  const x = (val: number) => M.left + (val / max) * (W - M.left - M.right);
  const y = (val: number) => H - M.bottom - (val / max) * (H - M.top - M.bottom);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-700" aria-hidden>
        {variants.map((v, i) => (
          <span key={v.name} className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: SERIES[i % SERIES.length] }} />
            {v.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <svg width="18" height="6" aria-hidden>
            <line x1="0" y1="3" x2="18" y2="3" stroke="#8a8984" strokeWidth="1.5" strokeDasharray="4 3" />
          </svg>
          perfectly calibrated
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full max-w-[640px]" role="img"
          aria-label="Calibration plot: predicted versus actual hidden bugs per bin">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)} stroke="#ecebe7" />
              <text x={M.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6b6a65">{fmt(t)}</text>
              <text x={x(t)} y={H - M.bottom + 18} textAnchor="middle" fontSize="11" fill="#6b6a65">{fmt(t)}</text>
            </g>
          ))}
          <line x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} stroke="#8a8984" strokeWidth="1.5" strokeDasharray="4 3" />
          <line x1={M.left} x2={W - M.right} y1={y(0)} y2={y(0)} stroke="#c9c8c2" />
          <text x={(M.left + W - M.right) / 2} y={H - 10} textAnchor="middle" fontSize="12" fill="#3d3c38">
            Predicted hidden bugs per unit (bin average)
          </text>
          <text transform={`translate(14 ${(M.top + H - M.bottom) / 2}) rotate(-90)`} textAnchor="middle" fontSize="12" fill="#3d3c38">
            Actual hidden bugs per unit
          </text>
          {variants.map((v, vi) => {
            const color = SERIES[vi % SERIES.length]!;
            const pts = [...v.bins].sort((a, b) => a.pred_mean - b.pred_mean);
            return (
              <g key={v.name}>
                <polyline
                  points={pts.map((b) => `${x(b.pred_mean)},${y(b.actual_mean)}`).join(" ")}
                  fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" opacity="0.55"
                />
                {pts.map((b, i) => (
                  <g key={i}>
                    {b.ci_low !== null && b.ci_high !== null ? (
                      <line x1={x(b.pred_mean)} x2={x(b.pred_mean)} y1={y(b.ci_low)} y2={y(b.ci_high)} stroke={color} strokeWidth="1.5" opacity="0.6" />
                    ) : null}
                    <circle cx={x(b.pred_mean)} cy={y(b.actual_mean)} r="5" fill={color} stroke="#fcfcfb" strokeWidth="2" />
                    <circle
                      cx={x(b.pred_mean)} cy={y(b.actual_mean)} r="14" fill="transparent"
                      onMouseEnter={() => setHover({ v: vi, b })} onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ v: vi, b })} onBlur={() => setHover(null)} tabIndex={0}
                      aria-label={tip(v.label, b)}
                    />
                  </g>
                ))}
              </g>
            );
          })}
        </svg>
        {hover ? (
          <div
            className="pointer-events-none absolute rounded border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-800 shadow-sm"
            style={{
              left: `${(x(hover.b.pred_mean) / W) * 100}%`,
              top: `${(y(hover.b.actual_mean) / H) * 100}%`,
              transform: "translate(12px, -110%)",
            }}
          >
            <div className="font-medium">{variants[hover.v]!.label}</div>
            <div>{hover.b.n} units, predicted {fmt(hover.b.pred_mean)}</div>
            <div>
              actual {fmt(hover.b.actual_mean)}
              {hover.b.ci_low !== null ? ` (95% CI ${fmt(hover.b.ci_low)}–${fmt(hover.b.ci_high!)})` : ""}
            </div>
          </div>
        ) : null}
      </div>
      <figcaption className="text-xs text-stone-500">
        Each point is a group of units with similar predictions. On the diagonal, predictions match reality; above it the
        estimate is too optimistic, below it too cautious.
      </figcaption>
    </figure>
  );
}

function tip(label: string, b: CalibrationVariant["bins"][number]) {
  return `${label}: ${b.n} units, predicted ${fmt(b.pred_mean)}, actual ${fmt(b.actual_mean)}`;
}

function fmt(v: number) {
  return v >= 10 ? v.toFixed(0) : v.toFixed(2).replace(/0$/, "");
}

function niceMax(v: number) {
  for (const step of [0.25, 0.5, 1, 2, 2.5, 5, 10]) {
    const m = Math.ceil(v / step) * step;
    if (m / step <= 8) return m;
  }
  return Math.ceil(v);
}
