import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { reviewQueue, triageLoad, type PrTriage } from "@prlens/shared";
import { CheckIcon, LensIcon, ShieldIcon } from "@/components/Icons";
import { RevealBox } from "@/components/pr/RevealBox";
import { Avatar, Pill, PriorityPill, buttonPrimary } from "@/components/ui";
import { pct, when } from "@/lib/format";
import { itemAnchor, itemLine, prHref, prIdFromKey, skipLabel } from "@/lib/pr";
import { loadAdaptive, loadTriagePr } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function ConversationPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const id = prIdFromKey(key);
  const pr = id ? await loadTriagePr(id) : null;
  if (!pr) notFound();
  const { readLines, totalLines } = triageLoad(pr);
  const queue = reviewQueue(pr.toReview);
  const byPriority = (p: string) => queue.filter((i) => i.priority === p).length;
  const skipCounts = new Map<string, number>();
  for (const s of pr.skipped) skipCounts.set(skipLabel(s.category), (skipCounts.get(skipLabel(s.category)) ?? 0) + 1);
  const isEval = pr.source === "eval";
  const adaptive = pr.source === "sample" ? null : await loadAdaptive(pr.repo);

  return (
    <div className="gap-8 md:grid md:grid-cols-[minmax(0,1fr)_256px]">
      <div className="min-w-0 space-y-4">
        <Comment author={pr.author.name} bot={pr.author.kind === "ai_agent"} meta={`${isEval ? "committed" : "opened"} ${when(pr.openedAt)}`}>
          <p className="whitespace-pre-line">{pr.taskSummary || "No description provided."}</p>
        </Comment>

        <div className="ml-4 flex items-center gap-2 border-l-2 border-line py-1 pl-6 text-sm text-muted md:ml-5">
          <LensIcon className="-ml-[33px] rounded-full bg-canvas p-0.5" size={20} />
          <span>
            <span className="font-semibold text-fg">PR Lens</span> scored every changed region with {pr.panel.join(" + ")}
          </span>
        </div>

        <Comment author="PR Lens" bot meta="triage summary">
          <p className="text-base">
            {queue.length ? (
              <>
                <span className="font-semibold">{queue.length} item{queue.length === 1 ? "" : "s"} need a human review</span>
                {" "}({byPriority("P0")} P0, {byPriority("P1")} P1, {byPriority("P2")} P2).
              </>
            ) : (
              <span className="font-semibold">Nothing here needs a human review.</span>
            )}{" "}
            Read <span className="font-semibold">{readLines}</span> of {totalLines} changed lines ({pct(totalLines ? readLines / totalLines : 0)}).
          </p>
          {pr.skipped.length ? (
            <p className="mt-2 text-muted">
              Skipped {pr.skipped.length}: {[...skipCounts.entries()].map(([k, v]) => `${v} ${k.toLowerCase()}`).join(", ")}. Each one stays one click away in
              Files changed.
            </p>
          ) : null}
          {queue.length ? (
            <ol className="mt-3 divide-y divide-line-muted rounded-md border border-line">
              {queue.slice(0, 6).map((it) => (
                <li key={it.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                  <PriorityPill priority={it.priority} />
                  <Link href={prHref(pr.id, "files", itemAnchor(it.id))} className="font-mono text-xs text-accent hover:underline">
                    {it.file}:{itemLine(it) ?? ""}
                  </Link>
                  {it.sameEdit ? <Pill>same edit in {it.sameEdit.size} places</Pill> : null}
                  <span className="min-w-0 flex-1 basis-60 text-sm text-fg">{it.reasons[0]?.detail}</span>
                </li>
              ))}
              {queue.length > 6 ? <li className="px-3 py-2 text-xs text-muted">and {queue.length - 6} more in Files changed</li> : null}
            </ol>
          ) : null}
          {pr.guarantee ? (
            <p className="mt-3 flex gap-2 text-sm text-muted">
              <ShieldIcon className="mt-0.5 shrink-0 text-success" />
              <span>
                Skip promise: if a PR has a functional bug, it lands in the skipped part at most {pct(pr.guarantee.missBound)} of the time
                ({pct(pr.guarantee.confidence)} confidence; {pr.guarantee.calibratedOn}).
              </span>
            </p>
          ) : null}
          <div className="mt-3">
            <Link href={prHref(pr.id, "files")} className={buttonPrimary}>
              Review in Files changed
            </Link>
          </div>
        </Comment>

        {pr.groundTruth ? <RevealBox pr={pr} /> : null}

        <MergeBox pr={pr} />
      </div>

      <aside className="mt-6 space-y-4 text-sm md:mt-0">
        <Side title="Reviewers">
          <div className="flex items-center gap-2">
            <Avatar name="PR Lens" bot size={20} />
            <span className="font-semibold text-fg">PR Lens</span>
            {queue.length ? <span className="ml-auto text-xs text-attention">wants a human</span> : <CheckIcon className="ml-auto text-success" />}
          </div>
        </Side>
        <Side title="Labels">
          <div className="flex flex-wrap gap-1">
            {queue.length ? <Pill tone="attention">{queue.length} to review</Pill> : <Pill tone="success">nothing to review</Pill>}
            <Pill tone="accent">reads {pct(totalLines ? readLines / totalLines : 0)}</Pill>
            {[...skipCounts.keys()].map((k) => (
              <Pill key={k}>{k.toLowerCase()}</Pill>
            ))}
          </div>
        </Side>
        {adaptive ? (
          <Side title="Skip threshold">
            <p className="text-muted">
              <span className="font-semibold text-fg">{adaptive.threshold ? pct(adaptive.threshold, 1) : "off"}</span> for {pr.repo}
              {adaptive.n ? `, after ${adaptive.n} PR${adaptive.n === 1 ? "" : "s"} with a bug` : "; adapts as bugs are reported"}
            </p>
          </Side>
        ) : null}
        <Side title="Scored by">
          <p className="text-muted">{pr.panel.join(", ")}</p>
        </Side>
        <Side title="Repository">
          <p className="font-mono text-xs text-muted">{pr.repo}</p>
        </Side>
      </aside>
    </div>
  );
}

function Comment({ author, bot, meta, children }: { author: string; bot?: boolean; meta: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="hidden sm:block">
        <Avatar name={author} bot={bot} size={40} />
      </span>
      <div className="min-w-0 flex-1 rounded-md border border-line">
        <div className="flex flex-wrap items-center gap-1.5 rounded-t-md border-b border-line bg-subtle px-4 py-2 text-sm text-muted">
          <span className="font-semibold text-fg">{author}</span>
          {bot ? <span className="rounded-full border border-line px-1.5 text-xs">bot</span> : null}
          <span>{meta}</span>
        </div>
        <div className="px-4 py-3 text-sm text-fg">{children}</div>
      </div>
    </div>
  );
}

function Side({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-b border-line-muted pb-3">
      <h3 className="mb-2 text-xs font-semibold text-muted">{title}</h3>
      {children}
    </div>
  );
}

function MergeBox({ pr }: { pr: PrTriage }) {
  const n = pr.toReview.length;
  return (
    <div className="flex gap-3">
      <span className={`hidden h-10 w-10 shrink-0 items-center justify-center rounded-md text-white sm:flex ${n ? "bg-attention" : "bg-success-emph"}`}>
        <LensIcon size={22} />
      </span>
      <div className={`flex-1 rounded-md border px-4 py-3 ${n ? "border-attention/50" : "border-success/50"}`}>
        <p className="font-semibold text-fg">{n ? `${n} region${n === 1 ? "" : "s"} need a human review before merging` : "PR Lens found nothing that needs a human"}</p>
        <p className="text-sm text-muted">
          {n ? "Mark each one reviewed in Files changed; skipped code is listed with its reason." : "Every change was skipped with a reason you can open in Files changed."}
        </p>
      </div>
    </div>
  );
}
