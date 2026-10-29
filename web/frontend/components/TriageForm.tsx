"use client";

import { useEffect, useState } from "react";
import type { AvailableModel, PipelineAction } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { ActionForm } from "./ActionForm";
import { JobLive } from "./JobLive";

/** Paste a GitHub PR link, check the cost, triage it, and watch it run. */
export function TriageForm() {
  const [action, setAction] = useState<PipelineAction | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      clientFetch<PipelineAction[]>("/api/pipeline/actions"),
      clientFetch<AvailableModel[]>("/api/models").catch(() => [] as AvailableModel[]),
    ])
      .then(([a, m]) => {
        setAction(a.find((x) => x.id === "triage-pr") ?? null);
        setModels(m);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <p className="text-sm text-danger">Could not reach the backend: {error}</p>;
  if (!action) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-6">
      <ActionForm action={action} models={models} onStarted={setJob} submitLabel="Triage this PR" />
      {job ? (
        <div className="border-t border-line pt-4">
          <JobLive id={job} compact />
        </div>
      ) : null}
    </div>
  );
}
