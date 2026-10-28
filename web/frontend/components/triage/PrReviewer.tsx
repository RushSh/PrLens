"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  REVIEW_REASONS,
  SKIP_CATEGORIES,
  sortForReview,
  triageLoad,
  type PrTriage,
  type Priority,
  type ReviewItem,
  type SkipCategory,
  type SkippedItem,
} from "@bugcensus/shared";
import { pct, when } from "@/lib/format";
import { DiffView } from "./DiffView";

const PRIORITY_TONE: Record<Priority, string> = {
  P0: "bg-red-50 text-red-800 ring-red-600/25",
  P1: "bg-amber-50 text-amber-800 ring-amber-600/25",
  P2: "bg-stone-100 text-stone-700 ring-stone-500/20",
};

export function PrReviewer({ prs, initialId }: { prs: PrTriage[]; initialId: string }) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialId);
  // reviewed items per PR (local state for now; persisted once the triage backend exists)
  const [reviewed, setReviewed] = useState<Record<string, Set<string>>>({});
  const pr = prs.find((p) => p.id === selectedId) ?? prs[0]!;

  const select = (id: string) => {
    setSelectedId(id);
    router.replace(`/pr-reviewer?pr=${encodeURIComponent(id)}`, { scroll: false });
  };
  const done = reviewed[pr.id] ?? new Set<string>();
  const toggleReviewed = (itemId: string) =>
    setReviewed((r) => {
      const next = new Set(r[pr.id] ?? []);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return { ...r, [pr.id]: next };
    });

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-stone-900">PR Reviewer</h1>
          <p className="max-w-3xl text-sm text-stone-500">
            Which parts of a pull request need a human, and why. Everything else is cleared out of the queue with its
            reason, and you can still open it.
          </p>
        </div>
        {pr.source === "sample" ? (
          <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/25">
            Sample data: scores and the skip bound are illustrative
          </span>
        ) : null}
      </div>

      <PrPicker prs={prs} selectedId={pr.id} onSelect={select} reviewed={reviewed} />
      <PrHeader pr={pr} reviewedCount={done.size} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ActionRequired items={pr.toReview} done={done} onToggle={toggleReviewed} />
        <SkippedList items={pr.skipped} />
      </div>
    </div>
  );
}

function PrPicker({
  prs,
  selectedId,
  onSelect,
  reviewed,
}: {
  prs: PrTriage[];
  selectedId: string;
  onSelect: (id: string) => void;
  reviewed: Record<string, Set<string>>;
}) {
  return (
    <div role="tablist" aria-label="Pull requests" className="flex gap-3 overflow-x-auto pb-1">
      {prs.map((p) => {
        const { readLines, totalLines } = triageLoad(p);
        const active = p.id === selectedId;
        const left = p.toReview.length - (reviewed[p.id]?.size ?? 0);
        return (
          <button
            key={p.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p.id)}
            className={`min-w-[240px] max-w-[300px] shrink-0 rounded-lg border px-3 py-2.5 text-left transition-colors ${
              active ? "border-stone-900 bg-white shadow-sm" : "border-stone-200 bg-white hover:border-stone-400"
            }`}
          >
            <div className="truncate text-sm font-medium text-stone-900">
              <span className="text-stone-400">#{p.number}</span> {p.title}
            </div>
            <div className="mt-0.5 truncate text-xs text-stone-500">{p.repo}</div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className={left ? "font-medium text-red-700" : "text-emerald-700"}>
                {left ? `${left} to review` : "all reviewed"}
              </span>
              <span className="text-stone-500">{p.skipped.length} skipped</span>
              <span className="tabular text-stone-500">reads {pct(readLines / totalLines)} of lines</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PrHeader({ pr, reviewedCount }: { pr: PrTriage; reviewedCount: number }) {
  const { readLines, totalLines } = triageLoad(pr);
  const share = totalLines ? readLines / totalLines : 0;
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-stone-900">
            <span className="text-stone-400">#{pr.number}</span> {pr.title}
          </h2>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-stone-500">
            <span className="font-mono">{pr.repo}</span>
            <span className="font-mono">{pr.branch}</span>
            <span>
              by {pr.author.name}
              {pr.author.kind === "ai_agent" ? " (AI agent)" : ""}
            </span>
            <span>opened {when(pr.openedAt)}</span>
            <span>scored by {pr.panel.join(", ")}</span>
          </div>
          <p className="mt-2 text-sm text-stone-700">
            <span className="font-medium">Task:</span> {pr.taskSummary}
          </p>
        </div>
        <div className="text-right text-sm">
          <div className="tabular text-2xl font-semibold text-stone-900">
            {readLines} <span className="text-base font-normal text-stone-500">of {totalLines} lines</span>
          </div>
          <div className="text-xs text-stone-500">to read ({pct(share)})</div>
        </div>
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-stone-100" aria-hidden>
        <div className="h-2 rounded-full bg-stone-800" style={{ width: `${share * 100}%` }} />
      </div>
      <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="font-medium text-red-800">{pr.toReview.length}</span> need review
          <span className="text-stone-500"> · {reviewedCount} done</span>
        </span>
        <span>
          <span className="font-medium text-stone-800">{pr.skipped.length}</span> auto-cleared
        </span>
        {pr.guarantee ? (
          <span className="text-stone-600">
            Skipped part: if this PR has a bug, it is in the skipped part at most{" "}
            <span className="font-medium">{pct(pr.guarantee.missBound)}</span> of the time ({pct(pr.guarantee.confidence)}{" "}
            confidence; {pr.guarantee.calibratedOn}). Covers functional bugs only.
          </span>
        ) : null}
      </div>
    </section>
  );
}

function ActionRequired({ items, done, onToggle }: { items: ReviewItem[]; done: Set<string>; onToggle: (id: string) => void }) {
  const sorted = useMemo(() => sortForReview(items), [items]);
  return (
    <section aria-labelledby="action-required" className="space-y-3">
      <header className="flex items-baseline justify-between">
        <h3 id="action-required" className="text-sm font-semibold uppercase tracking-wide text-red-800">
          Action required <span className="font-normal normal-case tracking-normal text-stone-500">· should be reviewed</span>
        </h3>
        <span className="text-xs text-stone-500">highest risk first</span>
      </header>
      {sorted.length ? (
        sorted.map((item, i) => (
          <ReviewCard key={item.id} item={item} rank={i + 1} done={done.has(item.id)} onToggle={() => onToggle(item.id)} defaultOpen={i === 0} />
        ))
      ) : (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-500">
          Nothing in this PR needs a human review.
        </p>
      )}
    </section>
  );
}

function ReviewCard({
  item,
  rank,
  done,
  onToggle,
  defaultOpen,
}: {
  item: ReviewItem;
  rank: number;
  done: boolean;
  onToggle: () => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [why, setWhy] = useState(false);
  return (
    <article className={`rounded-lg border bg-white ${done ? "border-stone-200 opacity-60" : "border-stone-300"}`}>
      <div className="flex items-start gap-3 p-3">
        <span className="tabular mt-0.5 w-5 shrink-0 text-right text-sm text-stone-400">{rank}</span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${PRIORITY_TONE[item.priority]}`}>
              {item.priority}
            </span>
            <span className="truncate font-mono text-xs text-stone-800">{item.file}</span>
            <span className="text-xs text-stone-500">
              +{item.added} −{item.removed}
            </span>
            {item.forcedByRule ? (
              <span className="rounded bg-stone-100 px-1.5 py-0.5 text-[11px] text-stone-600" title="A rule put this here, not the risk score">
                always reviewed
              </span>
            ) : null}
          </div>
          <RiskBar score={item.riskScore} />
          <ul className="space-y-1.5">
            {item.reasons.map((r, i) => (
              <li key={i} className="text-sm text-stone-800">
                <span
                  className="mr-1.5 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-800 ring-1 ring-inset ring-red-600/20"
                  title={REVIEW_REASONS[r.code].help}
                >
                  {REVIEW_REASONS[r.code].label}
                </span>
                {r.detail}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-3 text-xs">
            <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-stone-700 underline-offset-2 hover:underline">
              {open ? "Hide diff" : "Show diff"}
            </button>
            <button type="button" aria-expanded={why} onClick={() => setWhy((v) => !v)} className="text-stone-700 underline-offset-2 hover:underline">
              {why ? "Hide signals" : "Why this score"}
            </button>
          </div>
          {why ? (
            <table className="w-full text-xs">
              <tbody>
                {item.signals.map((s) => (
                  <tr key={s.name} className="border-t border-stone-100">
                    <td className="py-1 pr-2 text-stone-600">{s.name}</td>
                    <td className="py-1 pr-2 text-stone-800">{s.value}</td>
                    <td className="w-24 py-1">
                      <div className="h-1.5 rounded-full bg-stone-100" aria-hidden>
                        <div className="h-1.5 rounded-full bg-stone-600" style={{ width: `${s.weight * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {open ? <DiffView header={item.header} lines={item.diff} /> : null}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-stone-600">
          <input type="checkbox" checked={done} onChange={onToggle} />
          Reviewed
        </label>
      </div>
    </article>
  );
}

function RiskBar({ score }: { score: number }) {
  const tone = score >= 0.6 ? "bg-red-600" : score >= 0.35 ? "bg-amber-500" : "bg-stone-400";
  return (
    <div className="flex items-center gap-2 text-xs text-stone-600">
      <span>Risk</span>
      <div className="h-1.5 w-32 rounded-full bg-stone-100" aria-hidden>
        <div className={`h-1.5 rounded-full ${tone}`} style={{ width: `${Math.max(0.03, score) * 100}%` }} />
      </div>
      <span className="tabular font-medium text-stone-800">{score.toFixed(2)}</span>
    </div>
  );
}

function SkippedList({ items }: { items: SkippedItem[] }) {
  const [showAll, setShowAll] = useState(false);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<SkipCategory, SkippedItem[]>();
    for (const it of items) m.set(it.category, [...(m.get(it.category) ?? []), it]);
    return [...m.entries()];
  }, [items]);
  const toggle = (id: string) =>
    setShown((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-labelledby="skipped" className="space-y-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="skipped" className="text-sm font-semibold uppercase tracking-wide text-stone-600">
          Skipped <span className="font-normal normal-case tracking-normal text-stone-500">· auto-cleared, safe to skip</span>
        </h3>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-stone-600">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show all diffs anyway
        </label>
      </header>
      {groups.length ? (
        groups.map(([cat, list]) => (
          <div key={cat} className="rounded-lg border border-stone-200 bg-white">
            <div className="flex items-baseline justify-between border-b border-stone-100 px-3 py-2">
              <span className="text-sm font-medium text-stone-800" title={SKIP_CATEGORIES[cat].help}>
                {SKIP_CATEGORIES[cat].label}
              </span>
              <span className="text-xs text-stone-500">{list.length}</span>
            </div>
            <ul className="divide-y divide-stone-100">
              {list.map((it) => {
                const visible = showAll || shown.has(it.id);
                return (
                  <li key={it.id} className="space-y-2 px-3 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-stone-800">{it.file}</div>
                        <div className="text-xs text-stone-500">{it.reason}</div>
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-stone-600">
                        <input type="checkbox" checked={visible} disabled={showAll} onChange={() => toggle(it.id)} />
                        View anyway
                      </label>
                    </div>
                    {visible ? <DiffView header={it.header} lines={it.diff} /> : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      ) : (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-500">Nothing was skipped.</p>
      )}
    </section>
  );
}
