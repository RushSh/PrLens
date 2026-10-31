"use client";

import { useEffect, useState } from "react";
import type { AvailableModel, PipelineAction } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { ActionForm } from "./ActionForm";
import { JobLive } from "./JobLive";
import { button } from "./ui";

interface Cached {
  url: string;
  repo: string;
  number: number;
  model: string;
  title: string | null;
}

/** Paste a GitHub PR link, check the cost, triage it, and watch it run. */
export function TriageForm() {
  const [action, setAction] = useState<PipelineAction | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cached, setCached] = useState<Cached[]>([]);
  const [preset, setPreset] = useState<string>("");

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
    clientFetch<Cached[]>("/api/triage/cached").then(setCached).catch(() => setCached([]));
  }, []);

  if (error) return <p className="text-sm text-danger">Could not reach the backend: {error}</p>;
  if (!action) return <p className="text-sm text-muted">Loading…</p>;
  return (
    <div className="space-y-6">
      {cached.length ? (
        <div className="rounded-md border border-line bg-subtle px-4 py-3 text-sm">
          <p className="font-semibold text-fg">Scores already cached: these triage instantly and cost nothing</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {cached.map((c) => (
              <button
                key={`${c.url}:${c.model}`}
                type="button"
                className={`${button} ${preset === c.url ? "border-accent text-accent" : ""}`}
                onClick={() => setPreset(c.url)}
                title={c.url}
              >
                <span className="font-mono text-xs">{c.repo}#{c.number}</span>
                {c.title ? <span className="max-w-[16rem] truncate text-muted">{c.title}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      <ActionForm
        key={preset}
        action={action}
        models={models}
        onStarted={setJob}
        submitLabel="Triage this PR"
        preset={preset ? { url: preset } : undefined}
      />
      {job ? (
        <div className="border-t border-line pt-4">
          <JobLive id={job} compact />
        </div>
      ) : null}
    </div>
  );
}
