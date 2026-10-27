import Link from "next/link";
import type { Job } from "@bugcensus/shared";
import { JobStatus } from "@/components/JobStatus";
import { Empty, Td, Th } from "@/components/ui";
import { serverGet } from "@/lib/api";
import { when } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const jobs = await serverGet<Job[]>("/api/jobs");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-stone-900">Jobs</h1>
      {jobs.length ? (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[640px]">
            <thead className="border-b border-stone-200 bg-stone-50">
              <tr>
                <Th>Started</Th>
                <Th>File</Th>
                <Th>Reviewers</Th>
                <Th>Status</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <Td>
                    <Link href={`/jobs/${j.id}`} className="hover:underline">
                      {when(j.startedAt ?? j.createdAt)}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{j.filePath}</Td>
                  <Td>{j.panel.join(", ")}</Td>
                  <Td>
                    <JobStatus status={j.status} />
                  </Td>
                  <Td>
                    {j.runId ? (
                      <Link className="underline" href={`/runs/${j.runId}`}>
                        View run
                      </Link>
                    ) : (
                      <span className="text-sm text-red-700">{j.error}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>No jobs yet. Start one from <Link className="underline" href="/new">New run</Link>.</Empty>
      )}
    </div>
  );
}
