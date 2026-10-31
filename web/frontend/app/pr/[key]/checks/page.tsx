import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { guaranteeText, triageLoad, type SkipCategory } from "@prlens/shared";
import { CheckIcon, DotIcon, LensIcon } from "@/components/Icons";
import { Box } from "@/components/ui";
import { pct } from "@/lib/format";
import { prIdFromKey, skipLabel } from "@/lib/pr";
import { loadAdaptive, loadEvalSet, loadTriagePr } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function ChecksPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const id = prIdFromKey(key);
  const [pr, evalSet] = await Promise.all([id ? loadTriagePr(id) : null, loadEvalSet()]);
  if (!pr) notFound();
  const adaptive = pr.source === "sample" ? null : await loadAdaptive(pr.repo);
  const { readLines, totalLines } = triageLoad(pr);
  const n = pr.toReview.length;
  const scored = pr.toReview.length + pr.skipped.filter((s) => s.category === "low_score").length;
  const cats = new Map<SkipCategory, number>();
  for (const s of pr.skipped) cats.set(s.category, (cats.get(s.category) ?? 0) + 1);
  const forced = pr.toReview.filter((i) => i.forcedByRule).length;

  const rows: [string, ReactNode][] = [
    ["Changed lines", `${totalLines} (${readLines} to read, ${pct(totalLines ? readLines / totalLines : 0)})`],
    ["Regions scored by a model", `${scored}, with ${pr.panel[0] ?? "the model"}`],
    ["Need a human", `${n}${forced ? ` (${forced} by rule: migrations, security, public API)` : ""}`],
    ["Skipped", [...cats.entries()].map(([c, k]) => `${k} ${skipLabel(c).toLowerCase()}`).join(", ") || "none"],
    [
      "Skip threshold used",
      pr.skipThreshold !== undefined
        ? pr.skipThreshold > 0
          ? `bug chance under ${pct(pr.skipThreshold, 1)}`
          : "none: nothing was skipped on score"
        : evalSet
          ? `bug chance under ${pct(evalSet.threshold, 1)}, chosen on the evaluation set`
          : "from the evaluation set",
    ],
    [
      `Adaptive threshold for ${pr.repo}`,
      adaptive
        ? adaptive.n
          ? `${adaptive.threshold ? pct(adaptive.threshold, 1) : "off"} now (started at ${pct(adaptive.threshold0, 1)}); ${adaptive.n} PR${adaptive.n === 1 ? "" : "s"} with a bug, ${adaptive.misses} in skipped code; ${guaranteeText(adaptive)}`
          : `${pct(adaptive.threshold, 1)}; moves after each review you finish in Files changed; ${guaranteeText(adaptive)}`
        : "not available",
    ],
    ["Skip promise", pr.guarantee ? `at most ${pct(pr.guarantee.missBound)} of bugs skipped, ${pct(pr.guarantee.confidence)} confidence; ${pr.guarantee.calibratedOn}` : "none"],
  ];
  if (pr.groundTruth) {
    rows.push(["Known bug", pr.groundTruth.caughtByTriage ? "kept in the review list" : "skipped (a miss)"]);
  }

  return (
    <Box
      title={
        <span className="flex items-center gap-2">
          <LensIcon /> PR Lens / triage
        </span>
      }
      right={
        <span className={`flex items-center gap-1 text-sm font-medium ${n ? "text-attention" : "text-success"}`}>
          {n ? <DotIcon /> : <CheckIcon />}
          {n ? `${n} region${n === 1 ? "" : "s"} need a human` : "Nothing needs a human"}
        </span>
      }
    >
      <dl className="divide-y divide-line-muted">
        {rows.map(([k, v]) => (
          <div key={k} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[200px_minmax(0,1fr)]">
            <dt className="text-muted">{k}</dt>
            <dd className="text-fg">{v}</dd>
          </div>
        ))}
      </dl>
    </Box>
  );
}
