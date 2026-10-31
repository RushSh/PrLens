"use client";

import Link from "next/link";
import { useState } from "react";
import type { PrTriage } from "@prlens/shared";
import { prHref } from "@/lib/pr";
import { BugIcon } from "../Icons";
import { button } from "../ui";

/** Evaluation PRs only: where the real bug was, hidden until asked for so the triage can be judged first. */
export function RevealBox({ pr }: { pr: PrTriage }) {
  const [shown, setShown] = useState(false);
  const gt = pr.groundTruth;
  if (!gt) return null;
  return (
    <div className="flex gap-3">
      <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-md bg-done text-white sm:flex">
        <BugIcon size={22} />
      </span>
      <div className="flex-1 rounded-md border border-done/40 px-4 py-3">
        <p className="font-semibold text-fg">
          {pr.source === "agent"
            ? "Muse Code's change fails a test from the later fix: it holds a real bug"
            : "This commit introduced a real bug that was fixed later"}
        </p>
        {shown ? (
          <div className="mt-1 space-y-1 text-sm">
            <p className={gt.caughtByTriage ? "text-success" : "text-danger"}>
              {gt.caughtByTriage ? "PR Lens kept it in the review list." : "PR Lens skipped the code that held it."}
            </p>
            {gt.fixes.map((f) => (
              <p key={f.sha} className="text-muted">
                {pr.source === "agent" ? "The human fix" : "Fixed in"} <span className="font-mono">{f.sha}</span>: {f.subject}{" "}
                <span className="text-xs">
                  ({f.evidence === "deleted"
                    ? "traced from the lines the fix changed"
                    : f.evidence === "labelled"
                      ? "bug region labelled by hand from the failing test"
                      : "traced from where the fix added code; weaker evidence"})
                </span>
              </p>
            ))}
            <Link href={prHref(pr.id, "files")} className="text-accent hover:underline">
              See it in Files changed (turn on “Reveal the real bug”)
            </Link>
          </div>
        ) : (
          <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-muted">
            <span>Judge the triage first, then check where the bug was.</span>
            <button type="button" className={button} onClick={() => setShown(true)}>
              Reveal the real bug
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
