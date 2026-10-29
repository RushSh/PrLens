"use client";

import { Fragment, useMemo, useState } from "react";
import { sortForReview, triageLoad, type PrTriage, type ReviewItem, type SkippedItem } from "@prlens/shared";
import { pct } from "@/lib/format";
import { buildFiles, fileAnchor, itemAnchor, itemLine, segments, skipLabel, type FileView, type ViewHunk } from "@/lib/pr";
import { BugIcon, CheckIcon, ChevronIcon, FileIcon, SkipIcon } from "../Icons";
import { Pill, PriorityPill } from "../ui";
import { DiffCols, DiffRows, HunkHeader } from "./DiffRows";
import { LensComment } from "./LensComment";

const MARKER = { P0: "bg-danger", P1: "bg-attention", P2: "bg-muted" } as const;

export function FilesChanged({ pr }: { pr: PrTriage }) {
  const files = useMemo(() => buildFiles(pr), [pr]);
  const items = useMemo(() => {
    const m = new Map<string, ReviewItem | SkippedItem>();
    for (const it of [...pr.toReview, ...pr.skipped]) m.set(it.id, it);
    return m;
  }, [pr]);
  const queue = useMemo(() => sortForReview(pr.toReview), [pr]);
  const { readLines, totalLines } = triageLoad(pr);

  const [viewed, setViewed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Map<string, boolean>>(new Map());
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showSkipped, setShowSkipped] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [side, setSide] = useState<"queue" | "files">("queue");

  const bugIds = useMemo(() => new Set(reveal ? (pr.groundTruth?.bugItemIds ?? []) : []), [reveal, pr]);
  const fileHasBug = (f: FileView) => [...f.review, ...f.skipped].some((it) => bugIds.has(it.id));
  const isOpen = (f: FileView) => open.get(f.path) ?? (!viewed.has(f.path) && (!f.allSkipped || fileHasBug(f)));
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const jumpTo = (it: ReviewItem) => {
    setOpen((m) => new Map(m).set(it.file, true));
    requestAnimationFrame(() => document.getElementById(itemAnchor(it.id))?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  return (
    <div className="gap-6 lg:grid lg:grid-cols-[300px_minmax(0,1fr)]">
      {/* sidebar: review queue or file list */}
      <aside className="mb-4 lg:sticky lg:top-4 lg:mb-0 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
        <div className="rounded-md border border-line">
          <div className="flex border-b border-line text-sm" role="tablist">
            {(["queue", "files"] as const).map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={side === s}
                onClick={() => setSide(s)}
                className={`flex-1 px-3 py-2 ${side === s ? "bg-subtle font-semibold text-fg" : "text-muted hover:text-fg"}`}
              >
                {s === "queue" ? `Review queue (${queue.length})` : `Files (${files.length})`}
              </button>
            ))}
          </div>
          {side === "queue" ? (
            <ol className="max-h-[50vh] overflow-y-auto lg:max-h-none">
              {queue.length ? (
                queue.map((it, i) => (
                  <li key={it.id} className="border-b border-line-muted last:border-b-0">
                    <button type="button" onClick={() => jumpTo(it)} className="flex w-full gap-2 px-3 py-2 text-left hover:bg-subtle">
                      <span className="tabular w-4 shrink-0 pt-0.5 text-xs text-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <PriorityPill priority={it.priority} />
                          <span className="truncate font-mono text-xs text-fg">
                            {it.file.split("/").pop()}:{itemLine(it) ?? ""}
                          </span>
                          {reviewed.has(it.id) ? <CheckIcon size={14} className="ml-auto shrink-0 text-success" /> : null}
                          {bugIds.has(it.id) ? <BugIcon size={14} className="shrink-0 text-danger" /> : null}
                        </span>
                        <span className="mt-0.5 line-clamp-2 text-xs text-muted">{it.reasons[0]?.detail}</span>
                      </span>
                    </button>
                  </li>
                ))
              ) : (
                <li className="px-3 py-4 text-sm text-muted">Nothing needs a human review.</li>
              )}
            </ol>
          ) : (
            <ul className="max-h-[50vh] overflow-y-auto py-1 lg:max-h-none">
              {files.map((f) => (
                <li key={f.path}>
                  <a
                    href={`#${fileAnchor(f.path)}`}
                    onClick={() => setOpen((m) => new Map(m).set(f.path, true))}
                    className={`flex items-center gap-2 px-3 py-1 text-xs hover:bg-subtle ${f.allSkipped ? "text-muted" : "text-fg"}`}
                  >
                    <FileIcon size={14} className="shrink-0" />
                    <span className="truncate font-mono">{f.path}</span>
                    {f.review.length ? (
                      <span className="tabular ml-auto rounded-full bg-attention-subtle px-1.5 text-attention">{f.review.length}</span>
                    ) : (
                      <span className="ml-auto">skipped</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-4">
        {/* toolbar */}
        <div className="sticky top-0 z-10 -mx-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-canvas/95 px-4 py-2 backdrop-blur md:mx-0 md:rounded-md md:border">
          <span className="text-sm text-muted">
            Read <span className="tabular font-semibold text-fg">{readLines}</span> of {totalLines} lines ({pct(totalLines ? readLines / totalLines : 0)})
          </span>
          <span className="tabular text-sm text-muted">
            {reviewed.size} / {pr.toReview.length} reviewed · {viewed.size} / {files.length} files viewed
          </span>
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-sm text-muted">
            <input type="checkbox" checked={showSkipped} onChange={(e) => setShowSkipped(e.target.checked)} />
            Show skipped code
          </label>
          {pr.groundTruth ? (
            <label className="flex cursor-pointer items-center gap-1.5 text-sm font-medium text-fg">
              <input type="checkbox" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              Reveal the real bug
            </label>
          ) : null}
        </div>

        {reveal && pr.groundTruth ? (
          <div
            className={`rounded-md border px-4 py-3 text-sm ${pr.groundTruth.caughtByTriage ? "border-success/40 bg-success-subtle" : "border-danger/40 bg-danger-subtle"}`}
          >
            <span className="font-semibold">
              {pr.groundTruth.caughtByTriage ? "Caught: the bug is in a PR Lens comment (outlined in red)." : "Missed: PR Lens skipped the code with the bug (opened and outlined in red)."}
            </span>{" "}
            {pr.groundTruth.fixes.map((f) => (
              <span key={f.sha} className="text-muted">
                Fixed later in <span className="font-mono">{f.sha}</span>: {f.subject}.{" "}
              </span>
            ))}
          </div>
        ) : null}

        {files.map((f) => {
          const isOpenNow = isOpen(f);
          const cats = [...new Set(f.skipped.map((s) => s.category))];
          return (
            <section key={f.path} id={fileAnchor(f.path)} className="scroll-mt-16 rounded-md border border-line">
              <header className={`flex flex-wrap items-center gap-2 bg-subtle px-2 py-1.5 ${isOpenNow ? "rounded-t-md border-b border-line" : "rounded-md"}`}>
                <button
                  type="button"
                  aria-expanded={isOpenNow}
                  aria-label={isOpenNow ? "Collapse file" : "Expand file"}
                  onClick={() => setOpen((m) => new Map(m).set(f.path, !isOpenNow))}
                  className="rounded p-1 text-muted hover:bg-line-muted"
                >
                  <ChevronIcon open={isOpenNow} />
                </button>
                <span className="min-w-0 truncate font-mono text-xs font-semibold text-fg sm:text-sm">{f.path}</span>
                <span className="tabular text-xs">
                  <span className="text-success">+{f.added}</span> <span className="text-danger">−{f.removed}</span>
                </span>
                {f.review.length ? <Pill tone="attention">{f.review.length} to review</Pill> : null}
                {f.allSkipped ? (
                  <Pill>
                    <SkipIcon size={12} /> skipped · {cats.map((c) => skipLabel(c).toLowerCase()).join(", ")}
                  </Pill>
                ) : null}
                <label className="ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-0.5 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={viewed.has(f.path)}
                    onChange={() => {
                      setViewed((v) => toggle(v, f.path));
                      setOpen((m) => {
                        const next = new Map(m);
                        next.delete(f.path);
                        return next;
                      });
                    }}
                  />
                  Viewed
                </label>
              </header>
              {isOpenNow ? (
                <table className="w-full table-fixed border-collapse font-mono text-xs leading-5">
                  <DiffCols />
                  <tbody>
                    {f.hunks.map((h) => (
                      <Hunk
                        key={h.id}
                        hunk={h}
                        items={items}
                        bugIds={bugIds}
                        showSkipped={showSkipped}
                        expanded={expanded}
                        onExpand={(id) => setExpanded((e) => toggle(e, id))}
                        reviewed={reviewed}
                        onReviewed={(id) => setReviewed((r) => toggle(r, id))}
                      />
                    ))}
                  </tbody>
                </table>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Hunk({
  hunk,
  items,
  bugIds,
  showSkipped,
  expanded,
  onExpand,
  reviewed,
  onReviewed,
}: {
  hunk: ViewHunk;
  items: Map<string, ReviewItem | SkippedItem>;
  bugIds: Set<string>;
  showSkipped: boolean;
  expanded: Set<string>;
  onExpand: (id: string) => void;
  reviewed: Set<string>;
  onReviewed: (id: string) => void;
}) {
  if (hunk.skipItem) {
    const it = hunk.skipItem;
    const isBug = bugIds.has(it.id);
    const show = showSkipped || expanded.has(it.id) || isBug;
    return (
      <>
        <SkipBar item={it} lines={it.added + it.removed} show={show} isBug={isBug} onToggle={() => onExpand(it.id)} />
        {show ? (
          <>
            <HunkHeader header={hunk.header} />
            <DiffRows lines={hunk.lines} marker={isBug ? "bg-danger" : undefined} />
          </>
        ) : null}
      </>
    );
  }
  return (
    <>
      <HunkHeader header={hunk.header} />
      {segments(hunk.lines).map((seg, i) => {
        const it = seg.itemId ? items.get(seg.itemId) : undefined;
        if (!it) return <DiffRows key={i} lines={seg.lines} />;
        const isBug = bugIds.has(it.id);
        if (it.tier === "skip") {
          const show = showSkipped || expanded.has(it.id) || isBug;
          return (
            <Fragment key={i}>
              <SkipBar item={it} lines={it.added + it.removed} show={show} isBug={isBug} onToggle={() => onExpand(it.id)} />
              {show ? <DiffRows lines={seg.lines} marker={isBug ? "bg-danger" : "bg-line"} /> : null}
            </Fragment>
          );
        }
        return (
          <Fragment key={i}>
            <DiffRows lines={seg.lines} marker={MARKER[it.priority]} />
            <tr>
              <td colSpan={5} className="p-0">
                <LensComment
                  item={it}
                  anchor={itemAnchor(it.id)}
                  isBug={isBug}
                  reviewed={reviewed.has(it.id)}
                  onReviewed={() => onReviewed(it.id)}
                />
              </td>
            </tr>
          </Fragment>
        );
      })}
    </>
  );
}

function SkipBar({ item, lines, show, isBug, onToggle }: { item: SkippedItem; lines: number; show: boolean; isBug: boolean; onToggle: () => void }) {
  return (
    <tr className={isBug ? "bg-danger-subtle" : "bg-subtle"}>
      <td colSpan={5} className="border-y border-line-muted px-3 py-1.5 font-sans">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <SkipIcon size={14} />
          <span className="font-semibold text-fg">Skipped</span>
          <span>· {skipLabel(item.category)}</span>
          <span>
            · {lines} line{lines === 1 ? "" : "s"}
          </span>
          {isBug ? (
            <Pill tone="danger">
              <BugIcon size={12} /> the real bug was here
            </Pill>
          ) : null}
          <button type="button" onClick={onToggle} className="ml-auto text-accent hover:underline" aria-expanded={show}>
            {show ? "Hide" : "Show"}
          </button>
        </div>
        <div className="mt-0.5 line-clamp-2 text-xs text-muted" title={item.reason}>
          {item.reason}
        </div>
      </td>
    </tr>
  );
}
