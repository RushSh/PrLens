import type { ReactNode } from "react";
import { modelName, reviewQueue, triageLoad, type PrTriage } from "@prlens/shared";
import { AgentIcon, LensIcon, PullIcon, CommentIcon, ChartIcon } from "../Icons";

/**
 * Who did what on this PR, left to right: who wrote the change, which model scored every region, how PR Lens turned
 * scores into a reading budget, and which model wrote the notes on what to check. Meta AI tools are marked as such.
 */
export function ModelPipeline({ pr }: { pr: PrTriage }) {
  const { readLines, totalLines } = triageLoad(pr);
  const scored = pr.toReview.length + pr.skipped.filter((s) => s.category === "low_score").length;
  const noModel = pr.skipped.filter((s) => s.category !== "low_score").length;
  const queue = reviewQueue(pr.toReview);
  const noted = queue.filter((i) => i.note).length;
  const noteModel = queue.find((i) => i.note)?.note?.model;
  const scorer = modelName(pr.panel[0] ?? "spark_open");
  const agent = pr.source === "agent" || pr.author.kind === "ai_agent";

  return (
    <ol className="grid gap-2 rounded-md border border-line bg-subtle p-2 text-sm sm:grid-cols-2 lg:grid-cols-4" aria-label="How this PR was triaged">
      <Step
        n={1}
        icon={agent ? <AgentIcon /> : <PullIcon />}
        title={agent ? "Muse Code wrote it" : pr.source === "eval" ? "A person committed it" : `${pr.author.name} opened it`}
        meta={agent}
        detail={agent ? "Meta's coding agent" : "human-written change"}
      />
      <Step
        n={2}
        icon={<ChartIcon />}
        title={`${scorer} scored it`}
        meta={scorer.startsWith("Muse")}
        detail={`${scored} region${scored === 1 ? "" : "s"} scored${noModel ? `; ${noModel} skipped without a model` : ""}`}
      />
      <Step
        n={3}
        icon={<LensIcon />}
        title="PR Lens set the budget"
        detail={`read ${readLines} of ${totalLines} lines; skip target ${pr.guarantee ? Math.round(pr.guarantee.missBound * 100) : 20}%`}
      />
      <Step
        n={4}
        icon={<CommentIcon />}
        title={noted ? `${noteModel ?? "Muse Spark"} explains it` : "Notes not generated"}
        meta={noted > 0}
        muted={!noted}
        detail={noted ? `what to check on ${noted} of ${queue.length} review item${queue.length === 1 ? "" : "s"}` : "prlens explain adds them"}
      />
    </ol>
  );
}

function Step({
  n,
  icon,
  title,
  detail,
  meta = false,
  muted = false,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  detail: string;
  meta?: boolean;
  muted?: boolean;
}) {
  return (
    <li className={`flex min-w-0 gap-2 rounded-md bg-canvas px-3 py-2 ${muted ? "opacity-60" : ""}`}>
      <span className="mt-0.5 shrink-0 text-muted" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs tabular text-muted">{n}</span>
          <span className="font-semibold text-fg">{title}</span>
          {meta ? <span className="rounded-full bg-accent-subtle px-1.5 text-[11px] font-medium text-accent">Meta AI</span> : null}
        </div>
        <div className="truncate text-xs text-muted" title={detail}>
          {detail}
        </div>
      </div>
    </li>
  );
}
