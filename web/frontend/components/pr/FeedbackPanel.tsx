"use client";

import { useEffect, useState } from "react";
import { guaranteeText, type AdaptiveState, type FeedbackOutcome, type PrFeedback } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { pct } from "@/lib/format";
import { CheckIcon, ShieldIcon } from "../Icons";
import { button, buttonPrimary } from "../ui";

interface Reply {
  feedback: PrFeedback | null;
  adaptive: AdaptiveState;
}

/**
 * The end of a review: where did a bug surface? In skipped code the repository's adaptive skip threshold tightens; in
 * reviewed code it loosens; with no bug nothing moves (a PR with no bug could not have missed one). Each PR counts once.
 */
export function FeedbackPanel({
  prId,
  reported,
  onClearReported,
}: {
  prId: string;
  reported: string[];
  onClearReported: () => void;
}) {
  const [state, setState] = useState<Reply | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const url = `/api/triage/prs/${encodeURIComponent(prId)}/feedback`;

  useEffect(() => {
    clientFetch<Reply>(url)
      .then(setState)
      .catch(() => setUnavailable(true)); // sample PRs and an offline backend: no feedback loop
  }, [url]);

  if (unavailable || !state) return null;
  const a = state.adaptive;
  const recorded = state.feedback && !editing;

  async function send(outcome: FeedbackOutcome) {
    setBusy(true);
    setError(null);
    try {
      setBefore(a.threshold);
      const r = await clientFetch<Reply>(url, { method: "POST", body: { outcome, itemIds: outcome === "bug_skipped" ? reported : [] } });
      setState(r);
      setEditing(false);
      onClearReported();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-line">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <ShieldIcon className="mt-0.5 shrink-0 text-success" size={18} />
        <div className="min-w-0 flex-1 text-sm">
          {recorded ? (
            <>
              <p className="font-semibold text-fg">
                {state.feedback!.outcome === "bug_skipped" ? (
                  <span className="text-danger">Recorded: a bug was found in skipped code.</span>
                ) : state.feedback!.outcome === "bug_reviewed" ? (
                  <span className="text-success">
                    <CheckIcon size={14} className="mr-1 inline" />
                    Recorded: the bug was in code PR Lens sent to review.
                  </span>
                ) : (
                  <span className="text-fg">Recorded: no bug found. This PR does not move the threshold.</span>
                )}
              </p>
              <p className="text-muted">
                {a.scope}&apos;s skip threshold is now <span className="font-semibold text-fg">{a.threshold ? pct(a.threshold, 1) : "off (nothing skipped on score)"}</span>
                {before !== null && before !== a.threshold ? <> (was {before ? pct(before, 1) : "off"})</> : null} after {a.n} PR{a.n === 1 ? "" : "s"} with a bug,{" "}
                {a.misses} of them in skipped code; {guaranteeText(a)}.
              </p>
            </>
          ) : (
            <>
              <p className="font-semibold text-fg">When you finish: did a bug surface, and where?</p>
              <p className="text-muted">
                {reported.length
                  ? `${reported.length} skipped region${reported.length === 1 ? "" : "s"} marked as holding a bug.`
                  : "Mark a skipped region with “Bug here” if you found one."}{" "}
                A bug in skipped code tightens {a.scope}&apos;s skip threshold, one in reviewed code loosens it, and no bug leaves it
                where it is (now {a.threshold ? pct(a.threshold, 1) : "off"}, after {a.n} PR{a.n === 1 ? "" : "s"} with a bug).
              </p>
            </>
          )}
          {error ? <p className="mt-1 text-danger">{error}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {recorded ? (
            <button type="button" className={button} onClick={() => setEditing(true)}>
              Change
            </button>
          ) : (
            <>
              <button type="button" className={`${button} text-danger`} disabled={busy || !reported.length} onClick={() => send("bug_skipped")}
                title={reported.length ? undefined : "Mark the skipped region with “Bug here” first"}>
                Bug in skipped code
              </button>
              <button type="button" className={button} disabled={busy || reported.length > 0} onClick={() => send("bug_reviewed")}>
                Bug in reviewed code
              </button>
              <button type="button" className={buttonPrimary} disabled={busy || reported.length > 0} onClick={() => send("no_bug")}>
                No bug found
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
