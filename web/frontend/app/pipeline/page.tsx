import Link from "next/link";
import type { Job } from "@prlens/shared";
import { JobStatus } from "@/components/JobLive";
import { Pipeline } from "@/components/Pipeline";
import { Box } from "@/components/ui";
import { serverGet } from "@/lib/api";
import { duration, when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const jobs = await serverGet<Job[]>("/api/jobs").catch(() => [] as Job[]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">Pipeline</h1>
        <p className="mt-1 max-w-3xl text-muted">
          How the evaluation set is built and calibrated, step by step: mine real bug fixes, trace them to the PRs that introduced
          them, score every region, fit the skip threshold, publish. Each step runs <span className="font-mono">prlens &lt;step&gt;</span>{" "}
          on this machine; paid steps show their cost before anything is called.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Pipeline />
        <Box title="Recent jobs">
          {jobs.length ? (
            <ul>
              {jobs.map((j) => {
                const secs = j.startedAt && j.finishedAt ? (new Date(j.finishedAt).getTime() - new Date(j.startedAt).getTime()) / 1000 : null;
                return (
                  <li key={j.id} className="border-b border-line-muted px-4 py-2 last:border-b-0">
                    <Link href={`/pipeline/jobs/${j.id}`} className="block truncate font-semibold text-fg hover:text-accent">
                      {j.title}
                    </Link>
                    <div className="flex items-center gap-2 text-xs text-muted">
                      <JobStatus status={j.status} />
                      <span>{when(j.createdAt)}</span>
                      {secs !== null ? <span>· {duration(secs)}</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-4 py-6 text-sm text-muted">No jobs yet.</p>
          )}
        </Box>
      </div>
    </div>
  );
}
