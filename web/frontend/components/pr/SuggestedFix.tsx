"use client";

import { useState } from "react";
import type { SuggestedFix as Fix } from "@prlens/shared";
import { AgentIcon, CheckIcon, XIcon } from "../Icons";
import { button } from "../ui";

const STATUS: Record<Fix["status"], { text: string; tone: string }> = {
  fixed: { text: "all pass", tone: "text-success" },
  "partly fixed": { text: "fewer fail", tone: "text-attention" },
  "not fixed": { text: "they still fail", tone: "text-danger" },
  apply_failed: { text: "the suggestion did not apply", tone: "text-muted" },
  not_loading: { text: "they did not load with it", tone: "text-muted" },
};

/**
 * The closed loop on an agent-study PR: Muse Code was shown the regions PR Lens flagged (with Muse Spark's notes and
 * questions, never the bug or its fix) and suggested a fix; the later fix's own tests judge it.
 */
export function SuggestedFix({ fix }: { fix: Fix }) {
  const [open, setOpen] = useState(false);
  const s = STATUS[fix.status];
  const lines = fix.diff.split("\n");
  const changed = lines.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
  return (
    <div className="flex gap-3">
      <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent text-white sm:flex">
        <AgentIcon size={22} />
      </span>
      <div className="min-w-0 flex-1 rounded-md border border-line">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-t-md border-b border-line bg-subtle px-4 py-2.5">
          <span className="font-semibold text-fg">Suggested fix from {fix.by}</span>
          <span className="rounded-full border border-attention/40 bg-attention-subtle px-2 text-xs font-medium text-attention">
            suggested, still needs human review
          </span>
          <span className="rounded-full border border-accent/30 bg-canvas px-1.5 text-[11px] font-medium text-accent">Meta AI</span>
        </div>
        <div className="space-y-2 px-4 py-3 text-sm">
          <p className="text-muted">
            {fix.by} saw only what a reviewer sees here: the task, its change, and the regions PR Lens flagged with Muse Spark&apos;s
            notes and questions. It never saw the bug, the later fix or its tests. {changed} changed line{changed === 1 ? "" : "s"}.
          </p>
          <p className={`flex items-center gap-1.5 font-semibold ${s.tone}`}>
            {fix.status === "fixed" ? <CheckIcon size={14} /> : fix.status === "not fixed" ? <XIcon size={14} /> : null}
            Judged by the later fix&apos;s tests: {s.text}
            <span className="font-normal text-muted">
              ({fix.tests.passed} pass, {fix.tests.failed} fail; on {fix.by}&apos;s change alone {fix.before.passed} pass,{" "}
              {fix.before.failed} fail)
            </span>
          </p>
          <button type="button" className={button} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Hide the suggestion" : "Show the suggestion"}
          </button>
          {open ? (
            <pre className="max-h-[420px] overflow-auto rounded-md border border-line bg-canvas p-2 font-mono text-xs leading-5">
              {lines.map((l, i) => (
                <div
                  key={i}
                  className={
                    /^(\+\+\+|---|diff |index )/.test(l)
                      ? "text-muted"
                      : l.startsWith("@@")
                        ? "bg-accent-subtle text-muted"
                        : l.startsWith("+")
                          ? "bg-success-subtle text-fg"
                          : l.startsWith("-")
                            ? "bg-danger-subtle text-fg"
                            : "text-fg"
                  }
                >
                  {l || " "}
                </div>
              ))}
            </pre>
          ) : null}
        </div>
      </div>
    </div>
  );
}
