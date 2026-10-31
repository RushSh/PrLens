"use client";

import { useState } from "react";
import { REVIEW_REASONS, type ReviewItem } from "@prlens/shared";
import { pct } from "@/lib/format";
import { itemAnchor, itemLine } from "@/lib/pr";
import { BugIcon, CheckIcon } from "../Icons";
import { Avatar, Pill, PriorityPill, button } from "../ui";

/** PR Lens's inline review comment under the lines of one review item, styled like a GitHub review comment. */
export function LensComment({
  item,
  lead,
  reviewed,
  onReviewed,
  isBug,
  anchor,
}: {
  item: ReviewItem;
  /** Set when this item repeats an edit shown in full elsewhere: it renders as a one-line note pointing there. */
  lead?: ReviewItem;
  reviewed: boolean;
  onReviewed: () => void;
  isBug: boolean;
  anchor: string;
}) {
  const [why, setWhy] = useState(false);
  if (lead && !isBug) {
    return (
      <div id={anchor} className="border-y border-line bg-subtle px-3 py-1.5 font-sans md:px-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <Avatar name="PR Lens" bot size={16} />
          <span>
            Same edit as{" "}
            <a href={`#${itemAnchor(lead.id)}`} className="font-mono text-accent hover:underline">
              {lead.file.split("/").pop()}:{itemLine(lead) ?? ""}
            </a>
            {lead.sameEdit ? ` (${lead.sameEdit.size} places)` : ""}; reviewed together.
          </span>
          {reviewed ? (
            <span className="inline-flex items-center gap-1 text-success">
              <CheckIcon size={12} /> reviewed
            </span>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <div id={anchor} className="border-y border-line bg-subtle px-3 py-3 font-sans md:px-4">
      <div
        className={`max-w-3xl rounded-md border bg-canvas ${isBug ? "border-danger ring-2 ring-danger/30" : "border-line"} ${reviewed ? "opacity-70" : ""}`}
      >
        <div className="flex flex-wrap items-center gap-2 rounded-t-md border-b border-line bg-subtle px-3 py-2 text-sm">
          <Avatar name="PR Lens" bot size={20} />
          <span className="font-semibold text-fg">PR Lens</span>
          <span className="rounded-full border border-line px-1.5 text-xs text-muted">bot</span>
          <PriorityPill priority={item.priority} />
          <span className="text-xs text-muted">
            risk score <span className="tabular font-semibold text-fg">{pct(item.riskScore)}</span>
          </span>
          {item.forcedByRule ? <Pill title="A rule put this here, not the risk score">always reviewed</Pill> : null}
          {item.sameEdit ? <Pill title="The same edit appears in several places; reviewing it here covers them all">same edit in {item.sameEdit.size} places</Pill> : null}
          {isBug ? (
            <Pill tone="danger">
              <BugIcon size={12} /> the real bug was here
            </Pill>
          ) : null}
        </div>
        <div className="space-y-2 px-3 py-2.5 text-sm text-fg">
          {item.note ? (
            <p className="rounded-md border-l-2 border-accent bg-accent-subtle px-2.5 py-1.5">
              <span className="mr-1.5 font-semibold">Check:</span>
              {item.note.text}
              <span className="ml-1.5 whitespace-nowrap text-xs text-muted">· {item.note.model}</span>
            </p>
          ) : null}
          {item.reasons.map((r, i) => (
            <p key={i}>
              <span className="mr-1.5 font-semibold" title={REVIEW_REASONS[r.code].help}>
                {REVIEW_REASONS[r.code].label}:
              </span>
              {r.detail}
            </p>
          ))}
          {why ? (
            <table className="w-full max-w-md text-xs">
              <tbody>
                {item.signals.map((s) => (
                  <tr key={s.name} className="border-t border-line-muted">
                    <td className="py-1 pr-2 text-muted">{s.name}</td>
                    <td className="tabular py-1 pr-2 text-fg">{s.value}</td>
                    <td className="w-24 py-1">
                      <div className="h-1.5 rounded-full bg-line-muted" aria-hidden>
                        <div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.min(1, s.weight) * 100}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line-muted px-3 py-2">
          <button type="button" className={button} onClick={onReviewed} aria-pressed={reviewed}>
            {reviewed ? <CheckIcon className="text-success" /> : null}
            {reviewed ? "Reviewed" : "Mark as reviewed"}
          </button>
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => setWhy((v) => !v)} aria-expanded={why}>
            {why ? "Hide score details" : "Why this score"}
          </button>
        </div>
      </div>
    </div>
  );
}
