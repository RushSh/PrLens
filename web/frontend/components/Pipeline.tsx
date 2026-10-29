"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { AvailableModel, PipelineAction } from "@prlens/shared";
import { clientFetch } from "@/lib/api";
import { ChevronIcon } from "./Icons";
import { ActionForm } from "./ActionForm";
import { Pill } from "./ui";

const LANE: Record<PipelineAction["lane"], string> = { models: "calls models", cpu: "runs locally", ops: "admin" };

/** Every allow-listed pipeline step, grouped, each with its form. */
export function Pipeline() {
  const router = useRouter();
  const [actions, setActions] = useState<PipelineAction[] | null>(null);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      clientFetch<PipelineAction[]>("/api/pipeline/actions"),
      clientFetch<AvailableModel[]>("/api/models").catch(() => [] as AvailableModel[]),
    ])
      .then(([a, m]) => {
        setActions(a.filter((x) => x.id !== "triage-pr"));
        setModels(m);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const groups = useMemo(() => {
    const out = new Map<string, PipelineAction[]>();
    for (const a of actions ?? []) out.set(a.group, [...(out.get(a.group) ?? []), a]);
    return [...out.entries()];
  }, [actions]);

  if (error) return <p className="text-sm text-danger">Could not load the pipeline: {error}. Is the backend running?</p>;
  if (!actions) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      {groups.map(([group, list]) => (
        <section key={group} className="rounded-md border border-line">
          <h2 className="rounded-t-md border-b border-line bg-subtle px-4 py-2 text-sm font-semibold text-fg">{group}</h2>
          <ul>
            {list.map((a) => {
              const isOpen = open === a.id;
              return (
                <li key={a.id} className="border-b border-line-muted last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(isOpen ? null : a.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2 px-4 py-3 text-left hover:bg-subtle"
                  >
                    <ChevronIcon open={isOpen} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-fg">{a.title}</span>
                        <Pill tone={a.paid ? "attention" : "neutral"}>{a.paid ? "paid · check cost first" : "free"}</Pill>
                        <span className="text-xs text-muted">{LANE[a.lane]}</span>
                      </span>
                      <span className="mt-0.5 block text-sm text-muted">{a.description}</span>
                    </span>
                  </button>
                  {isOpen ? (
                    <div className="px-4 pb-4 pl-10">
                      <ActionForm action={a} models={models} onStarted={(id) => router.push(`/pipeline/jobs/${id}`)} />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
