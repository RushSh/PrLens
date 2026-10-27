import Link from "next/link";
import type { ReactNode } from "react";
import type { RunDetail } from "@bugcensus/shared";
import { Card, Empty, ModelChip, Verdict } from "@/components/ui";
import { serverGet } from "@/lib/api";
import { duration, int, num, pct, when } from "@/lib/format";

export const dynamic = "force-dynamic";

type Row = { label: string; value: (r: RunDetail) => ReactNode; key?: (r: RunDetail) => string };

const ROWS: Row[] = [
  { label: "When", value: (r) => when(r.finishedAt) },
  { label: "File", value: (r) => <span className="font-mono text-xs">{r.filePath}</span>, key: (r) => r.filePath },
  {
    label: "Reviewers",
    value: (r) => (
      <div className="flex flex-wrap gap-1">
        {r.models.map((m) => (
          <ModelChip key={m.reviewer} model={m} />
        ))}
      </div>
    ),
    key: (r) => r.models.map((m) => `${m.reviewer}:${m.modelId}:${m.provider}:${m.reasoningEffort}`).join(","),
  },
  { label: "Review prompt", value: (r) => <span className="font-mono text-xs">{r.promptSha ?? "not recorded"}</span>, key: (r) => r.promptSha ?? "" },
  { label: "Code version", value: (r) => <span className="font-mono text-xs">{r.gitSha ?? "not recorded"}</span>, key: (r) => r.gitSha ?? "" },
  {
    label: "Copies × decoys, seed",
    value: (r) => {
      const s = r.settings as { n_copies?: number; per_copy?: number; seed?: number };
      return s.n_copies !== undefined ? `${s.n_copies} × ${s.per_copy}, seed ${s.seed}` : "–";
    },
  },
  { label: "Verdict", value: (r) => <Verdict verdict={r.verdict} hidden={r.hiddenStatus} />, key: (r) => r.verdict },
  { label: "Suspected bugs found", value: (r) => r.foundCounted, key: (r) => String(r.foundCounted) },
  {
    label: "Decoys caught",
    value: (r) => `${r.decoysCounted - r.decoysMissed} of ${r.decoysCounted}${r.decoysNotReviewed ? ` (+${r.decoysNotReviewed} not reviewed)` : ""}`,
    key: (r) => `${r.decoysCounted - r.decoysMissed}/${r.decoysCounted}`,
  },
  {
    label: "Still hidden (est.)",
    value: (r) => (r.expectedHidden !== null ? `${num(r.expectedHidden)} (90%: ${r.intervalLow}–${r.intervalHigh})` : "–"),
    key: (r) => num(r.expectedHidden),
  },
  { label: "P(clean)", value: (r) => pct(r.pClean), key: (r) => pct(r.pClean) },
  { label: "Panel blind rate", value: (r) => pct(r.qMean, 1), key: (r) => pct(r.qMean, 1) },
  { label: "Output tokens", value: (r) => int(r.tokensOut) },
  { label: "Time", value: (r) => duration(r.seconds) },
  {
    label: "Problems",
    value: (r) => (r.errors.length ? <span className="text-red-700">{r.errors.join("; ")}</span> : <span className="text-stone-400">none</span>),
    key: (r) => String(r.errors.length),
  },
  { label: "Note", value: (r) => r.note ?? <span className="text-stone-400">–</span> },
];

function decoyKey(description: string) {
  return description;
}

export default async function ComparePage({ searchParams }: { searchParams: Promise<{ ids?: string }> }) {
  const { ids } = await searchParams;
  if (!ids) return <Empty>Pick two or more runs on the <Link className="underline" href="/">Runs</Link> page.</Empty>;
  const runs = await serverGet<RunDetail[]>(`/api/compare?ids=${encodeURIComponent(ids)}`);
  if (runs.length < 2) return <Empty>Need at least two runs to compare.</Empty>;

  const decoyKeys = [...new Set(runs.flatMap((r) => r.decoys.map((d) => decoyKey(d.description))))].sort();
  // fixed label column, equal run columns; long text wraps instead of widening a column
  const grid = {
    gridTemplateColumns: `minmax(140px, 180px) repeat(${runs.length}, minmax(200px, 1fr))`,
    minWidth: `${180 + runs.length * 220}px`,
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-stone-900">Compare {runs.length} runs</h1>
        <p className="text-sm text-stone-500">Rows where the runs differ are highlighted.</p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <div className="grid w-full text-sm" style={grid}>
            <div />
            {runs.map((r) => (
              <div key={r.id} className="px-3 pb-2">
                <Link href={`/runs/${r.id}`} className="text-sm font-medium text-stone-900 hover:underline">
                  Open run →
                </Link>
              </div>
            ))}
            {ROWS.map((row) => {
              const differs = row.key ? new Set(runs.map(row.key)).size > 1 : false;
              return (
                <div key={row.label} className="contents">
                  <div className={`border-t border-stone-100 px-3 py-2 text-stone-500 ${differs ? "bg-amber-50" : ""}`}>{row.label}</div>
                  {runs.map((r) => (
                    <div key={r.id} className={`tabular min-w-0 break-words border-t border-stone-100 px-3 py-2 ${differs ? "bg-amber-50 font-medium" : ""}`}>
                      {row.value(r)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </Card>

      <Card title="Decoy by decoy" right={<span className="text-xs text-stone-500">same decoy = same change at the same place</span>}>
        <div className="overflow-x-auto">
          <div className="grid w-full text-sm" style={grid}>
            {decoyKeys.map((k) => (
              <div key={k} className="contents">
                <div className="min-w-0 break-words border-t border-stone-100 px-3 py-1.5 font-mono text-xs text-stone-700">{k}</div>
                {runs.map((r) => {
                  const d = r.decoys.find((x) => decoyKey(x.description) === k);
                  return (
                    <div key={r.id} className="min-w-0 border-t border-stone-100 px-3 py-1.5 text-xs">
                      {!d ? (
                        <span className="text-stone-300">not planted</span>
                      ) : d.notReviewed ? (
                        <span className="text-amber-700">not reviewed ({d.copyName})</span>
                      ) : d.caughtBy.length ? (
                        <span className="text-emerald-700">caught by {d.caughtBy.join(", ")}</span>
                      ) : (
                        <span className="font-semibold text-red-700">missed</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Suspected bugs">
        <div className="overflow-x-auto">
        <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(200px, 1fr))`, minWidth: `${runs.length * 220}px` }}>
          {runs.map((r) => (
            <ul key={r.id} className="space-y-1.5 text-sm">
              {r.suspectedBugs.length ? (
                r.suspectedBugs.map((b, i) => (
                  <li key={i}>
                    <span className="font-mono text-xs text-stone-500">lines {b.startLine}–{b.endLine}</span> {b.explanations[0]}
                  </li>
                ))
              ) : (
                <li className="text-stone-400">none</li>
              )}
            </ul>
          ))}
        </div>
        </div>
      </Card>
    </div>
  );
}
