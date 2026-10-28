"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import {
  REVIEW_REASONS,
  SKIP_CATEGORIES,
  sortForReview,
  triageLoad,
  type PrTriage,
  type PrTriageSummary,
  type Priority,
  type ReviewItem,
  type SkipCategory,
  type SkippedItem,
  type TriageList,
} from "@bugcensus/shared";
import { pct, when } from "@/lib/format";
import { DiffView } from "./DiffView";

const PRIORITY_TONE: Record<Priority, string> = {
  P0: "bg-red-50 text-red-800 ring-red-600/25",
  P1: "bg-amber-50 text-amber-800 ring-amber-600/25",
  P2: "bg-stone-100 text-stone-700 ring-stone-500/20",
};

const prLabel = (p: { number: number | null; branch: string }) => (p.number !== null ? `#${p.number}` : p.branch);

export function PrReviewer({ list, pr, sample }: { list: TriageList; pr: PrTriage; sample: boolean }) {
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [reveal, setReveal] = useState(false);
  const bugIds = useMemo(() => new Set(reveal ? pr.groundTruth?.bugItemIds ?? [] : []), [reveal, pr]);
  const toggleReviewed = (itemId: string) =>
    setReviewed((r) => {
      const next = new Set(r);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
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
        {sample ? (
          <span className="rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 ring-1 ring-inset ring-amber-600/25">
            Sample data: no triage set imported yet
          </span>
        ) : pr.source === "eval" ? (
          <span className="rounded bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800 ring-1 ring-inset ring-sky-600/25">
            Evaluation set: real commits with a known bug
          </span>
        ) : null}
      </div>

      <PrPicker list={list} selectedId={pr.id} />
      <PrHeader pr={pr} reviewedCount={reviewed.size} reveal={reveal} onReveal={setReveal} />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ActionRequired items={pr.toReview} done={reviewed} onToggle={toggleReviewed} bugIds={bugIds} />
        <SkippedList items={pr.skipped} bugIds={bugIds} />
      </div>
    </div>
  );
}

function PrPicker({ list, selectedId }: { list: TriageList; selectedId: string }) {
  const router = useRouter();
  const [missedOnly, setMissedOnly] = useState(false);
  const known = list.prs.some((p) => p.caughtByTriage !== null);
  const shown = missedOnly ? list.prs.filter((p) => p.caughtByTriage === false || p.id === selectedId) : list.prs;
  const byRepo = useMemo(() => {
    const m = new Map<string, PrTriageSummary[]>();
    for (const p of shown) m.set(p.repo, [...(m.get(p.repo) ?? []), p]);
    return [...m.entries()];
  }, [shown]);
  const order = byRepo.flatMap(([, ps]) => ps);
  const at = order.findIndex((p) => p.id === selectedId);
  const go = (id: string | undefined) => {
    if (id) router.push(`/pr-reviewer?pr=${encodeURIComponent(id)}`, { scroll: false });
  };
  const s = list.set?.summary;
  const caught = list.prs.filter((p) => p.caughtByTriage).length;

  return (
    <section className="space-y-3 rounded-lg border border-stone-200 bg-white p-3">
      {s && list.set ? (
        <p className="text-sm text-stone-700">
          <span className="font-medium">{s.prs} real commits</span> from {s.repos} repositories, each of which introduced
          a bug that was fixed later. Triage kept the bug in the review list for{" "}
          <span className="font-medium">
            {caught} of {s.prs}
          </span>{" "}
          while leaving <span className="font-medium">{pct(s.read_share)}</span> of lines to read. Each PR was scored by
          a model fit without its repository; choosing the skip threshold that way too, {s.held_out_missed} of {s.prs}{" "}
          bugs were skipped.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => go(order[at - 1]?.id)}
          disabled={at <= 0}
          className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-700 disabled:opacity-40"
          aria-label="Previous PR"
        >
          ←
        </button>
        <select
          aria-label="Pull request"
          value={selectedId}
          onChange={(e) => go(e.target.value)}
          className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-2 py-1.5 text-sm text-stone-800"
        >
          {byRepo.map(([repo, ps]) => (
            <optgroup key={repo} label={repo}>
              {ps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.caughtByTriage === null ? "" : p.caughtByTriage ? "✓ " : "✗ "}
                  {prLabel(p)} · {p.title.slice(0, 70)} · reads {pct(p.readLines / Math.max(1, p.totalLines))}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          onClick={() => go(order[at + 1]?.id)}
          disabled={at < 0 || at >= order.length - 1}
          className="rounded border border-stone-300 px-2 py-1 text-sm text-stone-700 disabled:opacity-40"
          aria-label="Next PR"
        >
          →
        </button>
        <span className="tabular text-xs text-stone-500">
          {at + 1} of {order.length}
        </span>
        {known ? (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-xs text-stone-600">
            <input type="checkbox" checked={missedOnly} onChange={(e) => setMissedOnly(e.target.checked)} />
            Only PRs where triage skipped the bug
          </label>
        ) : null}
      </div>
    </section>
  );
}

function PrHeader({
  pr,
  reviewedCount,
  reveal,
  onReveal,
}: {
  pr: PrTriage;
  reviewedCount: number;
  reveal: boolean;
  onReveal: (v: boolean) => void;
}) {
  const { readLines, totalLines } = triageLoad(pr);
  const share = totalLines ? readLines / totalLines : 0;
  const gt = pr.groundTruth;
  return (
    <section className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-stone-900">
            {pr.number !== null ? <span className="text-stone-400">#{pr.number} </span> : null}
            {pr.title}
          </h2>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-stone-500">
            <span className="font-mono">{pr.repo}</span>
            <span className="font-mono">{pr.number !== null ? pr.branch : `commit ${pr.branch}`}</span>
            <span>
              by {pr.author.name}
              {pr.author.kind === "ai_agent" ? " (AI agent)" : ""}
            </span>
            <span>{pr.number !== null ? "opened" : "committed"} {when(pr.openedAt)}</span>
            <span>scored by {pr.panel.join(", ")}</span>
          </div>
          <p className="mt-2 whitespace-pre-line text-sm text-stone-700">
            <span className="font-medium">{pr.number !== null ? "Task:" : "Message:"}</span> {pr.taskSummary}
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
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <span>
          <span className="font-medium text-red-800">{pr.toReview.length}</span> need review
          <span className="text-stone-500"> · {reviewedCount} done</span>
        </span>
        <span>
          <span className="font-medium text-stone-800">{pr.skipped.length}</span> auto-cleared
        </span>
        {gt ? (
          <label className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-stone-800">
            <input type="checkbox" checked={reveal} onChange={(e) => onReveal(e.target.checked)} />
            Reveal the real bug
          </label>
        ) : null}
      </div>
      {pr.guarantee ? (
        <p className="mt-2 text-sm text-stone-600">
          Skip promise: if a PR has a bug, it lands in the skipped part at most{" "}
          <span className="font-medium">{pct(pr.guarantee.missBound)}</span> of the time ({pct(pr.guarantee.confidence)}{" "}
          confidence; {pr.guarantee.calibratedOn}). Covers functional bugs only.
        </p>
      ) : null}
      {gt && reveal ? (
        <div
          className={`mt-3 rounded border px-3 py-2 text-sm ${
            gt.caughtByTriage ? "border-emerald-300 bg-emerald-50 text-emerald-900" : "border-red-300 bg-red-50 text-red-900"
          }`}
        >
          <div className="font-medium">
            {gt.caughtByTriage
              ? "Caught: the bug is in the Action required list (outlined in red)."
              : "Missed: triage skipped the part with the bug (outlined in red on the right)."}
          </div>
          <ul className="mt-1 space-y-0.5 text-xs">
            {gt.fixes.map((f) => (
              <li key={f.sha}>
                Fixed later in <span className="font-mono">{f.sha}</span>: {f.subject}
                <span className="text-stone-500">
                  {" "}
                  ({f.evidence === "deleted" ? "traced from the lines the fix changed" : "traced from where the fix added code; weaker evidence"})
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function ActionRequired({
  items,
  done,
  onToggle,
  bugIds,
}: {
  items: ReviewItem[];
  done: Set<string>;
  onToggle: (id: string) => void;
  bugIds: Set<string>;
}) {
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
          <ReviewCard
            key={item.id}
            item={item}
            rank={i + 1}
            done={done.has(item.id)}
            onToggle={() => onToggle(item.id)}
            defaultOpen={i === 0}
            isBug={bugIds.has(item.id)}
          />
        ))
      ) : (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-500">
          Nothing in this PR needs a human review.
        </p>
      )}
    </section>
  );
}

function BugTag() {
  return (
    <span className="rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">The real bug was here</span>
  );
}

function ReviewCard({
  item,
  rank,
  done,
  onToggle,
  defaultOpen,
  isBug,
}: {
  item: ReviewItem;
  rank: number;
  done: boolean;
  onToggle: () => void;
  defaultOpen: boolean;
  isBug: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [why, setWhy] = useState(false);
  const showDiff = open || isBug;
  return (
    <article
      className={`rounded-lg border bg-white ${isBug ? "border-red-500 ring-2 ring-red-500/30" : done ? "border-stone-200 opacity-60" : "border-stone-300"}`}
    >
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
            {isBug ? <BugTag /> : null}
          </div>
          <RiskBar score={item.riskScore} priority={item.priority} />
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
            <button type="button" aria-expanded={showDiff} onClick={() => setOpen((v) => !v)} className="text-stone-700 underline-offset-2 hover:underline">
              {showDiff ? "Hide diff" : "Show diff"}
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
          {showDiff ? <DiffView header={item.header} lines={item.diff} /> : null}
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-stone-600">
          <input type="checkbox" checked={done} onChange={onToggle} />
          Reviewed
        </label>
      </div>
    </article>
  );
}

const BAR_TONE: Record<Priority, string> = { P0: "bg-red-600", P1: "bg-amber-500", P2: "bg-stone-400" };

function RiskBar({ score, priority }: { score: number; priority: Priority }) {
  return (
    <div className="flex items-center gap-2 text-xs text-stone-600">
      <span>Bug chance</span>
      <div className="h-1.5 w-32 rounded-full bg-stone-100" aria-hidden>
        <div className={`h-1.5 rounded-full ${BAR_TONE[priority]}`} style={{ width: `${Math.max(0.03, Math.min(1, score)) * 100}%` }} />
      </div>
      <span className="tabular font-medium text-stone-800">{pct(score)}</span>
    </div>
  );
}

function SkippedList({ items, bugIds }: { items: SkippedItem[]; bugIds: Set<string> }) {
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
                const isBug = bugIds.has(it.id);
                const visible = showAll || shown.has(it.id) || isBug;
                return (
                  <li key={it.id} className={`space-y-2 px-3 py-2 ${isBug ? "bg-red-50 ring-2 ring-inset ring-red-500" : ""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-stone-800">
                          {it.file} <span className="text-stone-400">+{it.added} −{it.removed}</span>
                        </div>
                        <div className="text-xs text-stone-500">{it.reason}</div>
                        {isBug ? <div className="mt-1"><BugTag /></div> : null}
                      </div>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-stone-600">
                        <input type="checkbox" checked={visible} disabled={showAll || isBug} onChange={() => toggle(it.id)} />
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
