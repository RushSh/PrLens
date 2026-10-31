import { reviewQueue } from "@prlens/shared";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { AgentIcon, CommitIcon, PullIcon } from "@/components/Icons";
import { PrTabs } from "@/components/pr/PrTabs";
import { when } from "@/lib/format";
import { buildFiles, prIdFromKey } from "@/lib/pr";
import { loadTriagePr } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function PrLayout({ children, params }: { children: ReactNode; params: Promise<{ key: string }> }) {
  const { key } = await params;
  const id = prIdFromKey(key);
  const pr = id ? await loadTriagePr(id) : null;
  if (!pr) notFound();
  const isEval = pr.source === "eval";
  const files = buildFiles(pr).length;

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-sm text-muted">
          <Link href="/" className="text-accent hover:underline">Pull requests</Link>
          <span className="mx-1">/</span>
          <span className="font-mono">{pr.repo}</span>
        </div>
        <h1 className="text-2xl font-normal leading-tight text-fg md:text-[32px]">
          {pr.title}{" "}
          <span className="font-light text-muted">{pr.number !== null ? `#${pr.number}` : pr.branch}</span>
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
          <span
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium text-white ${isEval ? "bg-done" : "bg-success-emph"}`}
          >
            {isEval ? <CommitIcon /> : pr.source === "agent" ? <AgentIcon /> : <PullIcon />}
            {isEval ? "Known bug" : pr.source === "agent" ? "Agent study" : pr.source === "sample" ? "Sample" : "Triaged"}
          </span>
          <span>
            <span className="font-semibold text-fg">{pr.author.name}</span>
            {pr.author.kind === "ai_agent" ? <span className="ml-1 rounded-full border border-line px-1.5 text-xs">bot</span> : null}{" "}
            {isEval ? (
              <>
                committed <span className="font-mono text-accent">{pr.branch}</span> {when(pr.openedAt)}
              </>
            ) : (
              <>
                wants to merge into <span className="rounded-md bg-accent-subtle px-1.5 font-mono text-xs text-accent">{pr.base ?? "main"}</span>{" "}
                from <span className="rounded-md bg-accent-subtle px-1.5 font-mono text-xs text-accent">{pr.branch}</span>
                {pr.url ? (
                  <>
                    {" · "}
                    <a href={pr.url} className="text-accent hover:underline" target="_blank" rel="noreferrer">
                      view on GitHub
                    </a>
                  </>
                ) : null}
              </>
            )}
          </span>
        </div>
      </div>
      <PrTabs base={`/pr/${key}`} files={files} toReview={reviewQueue(pr.toReview).length} />
      {children}
    </div>
  );
}
