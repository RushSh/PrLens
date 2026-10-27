"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Job } from "@bugcensus/shared";
import { clientFetch } from "@/lib/api";
import { duration, when } from "@/lib/format";
import { JobStatus } from "./JobStatus";

/** Polls a job every 3 s while it is queued or running and shows its log. */
export function JobLive({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const j = await clientFetch<Job>(`/api/jobs/${id}`);
        if (stop) return;
        setJob(j);
        setNow(Date.now());
        if (j.status === "queued" || j.status === "running") timer = setTimeout(poll, 3000);
      } catch (e) {
        if (!stop) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [job?.log]);

  if (error) return <p className="text-sm text-red-700">{error}</p>;
  if (!job) return <p className="text-sm text-stone-500">Loading…</p>;

  const active = job.status === "queued" || job.status === "running";
  const elapsed = job.startedAt
    ? ((job.finishedAt ? new Date(job.finishedAt).getTime() : now) - new Date(job.startedAt).getTime()) / 1000
    : null;

  async function cancel() {
    try {
      await clientFetch(`/api/jobs/${id}/cancel`, { method: "POST", body: {} });
      const j = await clientFetch<Job>(`/api/jobs/${id}`);
      setJob(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-xs text-stone-500">
            <Link href="/jobs" className="hover:underline">Jobs</Link> / {when(job.createdAt)}
          </div>
          <h1 className="font-mono text-lg font-semibold">{job.filePath}</h1>
          <div className="text-sm text-stone-600">Reviewers: {job.panel.join(", ")}</div>
          {job.note ? <div className="text-sm text-stone-500">{job.note}</div> : null}
        </div>
        <div className="flex items-center gap-3">
          <JobStatus status={job.status} />
          {elapsed !== null ? <span className="tabular text-sm text-stone-600">{duration(elapsed)}</span> : null}
          {active ? (
            <button type="button" onClick={cancel} className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-50">
              Cancel
            </button>
          ) : null}
        </div>
      </div>

      {job.status === "succeeded" && job.runId ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
          Done. <Link href={`/runs/${job.runId}`} className="font-medium underline">Open the run →</Link>
        </div>
      ) : null}
      {job.error && job.status !== "succeeded" ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{job.error}</div>
      ) : null}
      {job.status === "queued" ? (
        <p className="text-sm text-stone-500">Waiting for the run before it to finish.</p>
      ) : null}

      <pre ref={logRef} className="max-h-[60vh] overflow-auto rounded-lg bg-stone-900 p-3 font-mono text-xs leading-5 text-stone-100">
        {job.log || "No output yet."}
      </pre>
    </div>
  );
}
