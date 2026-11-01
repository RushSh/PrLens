"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Job, JobStatus as Status } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { duration, when } from "@/lib/format";
import { prHref } from "@/lib/pr";
import { CheckIcon, DotIcon, XIcon } from "./Icons";
import { button, buttonPrimary } from "./ui";

const TONE: Record<Status, string> = {
  queued: "text-muted",
  running: "text-attention",
  succeeded: "text-success",
  failed: "text-danger",
  cancelled: "text-muted",
};

export function JobStatus({ status }: { status: Status }) {
  return (
    <span className={`inline-flex items-center gap-1 text-sm font-medium ${TONE[status]}`}>
      {status === "succeeded" ? <CheckIcon size={14} /> : status === "failed" || status === "cancelled" ? <XIcon size={14} /> : <DotIcon size={14} />}
      {status}
    </span>
  );
}

/** Polls a job every 2 s while it is queued or running and shows its log. */
export function JobLive({ id, compact = false }: { id: string; compact?: boolean }) {
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
        if (j.status === "queued" || j.status === "running") timer = setTimeout(poll, 2000);
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

  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!job) return <p className="text-sm text-muted">Loading…</p>;

  const active = job.status === "queued" || job.status === "running";
  const elapsed = job.startedAt
    ? ((job.finishedAt ? new Date(job.finishedAt).getTime() : now) - new Date(job.startedAt).getTime()) / 1000
    : null;

  async function cancel() {
    try {
      await clientFetch(`/api/jobs/${id}/cancel`, { method: "POST", body: {} });
      setJob(await clientFetch<Job>(`/api/jobs/${id}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {!compact ? (
            <div className="text-xs text-muted">
              <Link href="/pipeline" className="text-accent hover:underline">Pipeline</Link> / started {when(job.createdAt)}
            </div>
          ) : null}
          <h2 className={`${compact ? "text-base" : "text-xl"} font-semibold text-fg`}>{job.title}</h2>
        </div>
        <div className="flex items-center gap-3">
          <JobStatus status={job.status} />
          {elapsed !== null ? <span className="tabular text-sm text-muted">{duration(elapsed)}</span> : null}
          {active ? (
            <button type="button" onClick={cancel} className={button}>
              Cancel
            </button>
          ) : null}
        </div>
      </div>
      {job.status === "succeeded" && job.prId ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-success/40 bg-success-subtle px-4 py-3 text-sm">
          <span>Triaged. The PR is in the list now.</span>
          <Link href={prHref(job.prId, "files")} className={buttonPrimary}>
            Open the PR
          </Link>
        </div>
      ) : job.status === "succeeded" ? (
        <div className="rounded-md border border-success/40 bg-success-subtle px-4 py-3 text-sm">Done. Results are imported automatically.</div>
      ) : null}
      {job.error && job.status !== "succeeded" ? (
        <div className="rounded-md border border-danger/40 bg-danger-subtle px-4 py-3 text-sm text-fg">{job.error}</div>
      ) : null}
      {job.status === "queued" ? <p className="text-sm text-muted">Waiting for the job before it in the same lane to finish.</p> : null}
      <pre ref={logRef} className="max-h-[50vh] overflow-auto rounded-md border border-line bg-inset p-3 font-mono text-xs leading-5 text-fg">
        {job.log || "No output yet."}
      </pre>
    </div>
  );
}
