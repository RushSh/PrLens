"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { launchRequest, type AvailableModel } from "@bugcensus/shared";
import { clientFetch } from "@/lib/api";
import { providerLabel } from "./ui";

export function LaunchForm() {
  const router = useRouter();
  const [models, setModels] = useState<AvailableModel[] | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [file, setFile] = useState("examples/billing.py");
  const [panel, setPanel] = useState<string[]>([]);
  const [copies, setCopies] = useState(2);
  const [perCopy, setPerCopy] = useState(5);
  const [seed, setSeed] = useState(0);
  const [lines, setLines] = useState("");
  const [note, setNote] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setLoadError(null);
    try {
      const [m, f] = await Promise.all([
        clientFetch<AvailableModel[]>(`/api/models${refresh ? "?refresh=1" : ""}`),
        clientFetch<string[]>("/api/files"),
      ]);
      setModels(m);
      setFiles(f);
      // keep only still-ready reviewers selected
      setPanel((p) => p.filter((name) => m.some((x) => x.reviewer === name && x.ready)));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const calls = panel.length * (1 + copies);
  const estimate = useMemo(() => {
    if (!models) return null;
    let dollars = 0;
    const other: string[] = [];
    for (const name of panel) {
      const m = models.find((x) => x.reviewer === name);
      if (!m) continue;
      if (m.costPerCall === null) other.push(`${name}: ${m.costNote}`);
      else dollars += m.costPerCall * (1 + copies);
    }
    return { dollars, other };
  }, [models, panel, copies]);

  const toggle = (name: string) => setPanel((p) => (p.includes(name) ? p.filter((x) => x !== name) : [...p, name]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    const parsed = launchRequest.safeParse({ file, panel, copies, perCopy, seed, lines, note: note || undefined });
    if (!parsed.success) {
      setSubmitError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      return;
    }
    setBusy(true);
    try {
      const { id } = await clientFetch<{ id: string }>("/api/jobs", { method: "POST", body: parsed.data });
      router.push(`/jobs/${id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <section className="rounded-lg border border-stone-200 bg-white p-4">
        <label className="block text-sm font-medium text-stone-800" htmlFor="file">
          File to review
        </label>
        <input
          id="file"
          list="known-files"
          value={file}
          onChange={(e) => setFile(e.target.value)}
          className="mt-1 w-full rounded border border-stone-300 px-2 py-1.5 font-mono text-sm"
          placeholder="examples/billing.py"
        />
        <datalist id="known-files">
          {files.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <p className="mt-1 text-xs text-stone-500">A Python file inside the BugCensus repository, relative to its root.</p>
      </section>

      <section className="rounded-lg border border-stone-200 bg-white">
        <header className="flex items-center justify-between border-b border-stone-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-stone-800">Reviewer models</h2>
          <button type="button" onClick={() => void load(true)} className="text-xs text-stone-600 hover:underline">
            Re-check availability
          </button>
        </header>
        {loadError ? (
          <p className="p-4 text-sm text-red-700">Could not load models: {loadError}. Is the backend running?</p>
        ) : !models ? (
          <p className="p-4 text-sm text-stone-500">Checking which models are set up…</p>
        ) : (
          <ul className="divide-y divide-stone-100">
            {models.map((m) => {
              const checked = panel.includes(m.reviewer);
              return (
                <li key={m.reviewer}>
                  <label className={`flex items-start gap-3 px-4 py-3 ${m.ready ? "cursor-pointer hover:bg-stone-50" : "opacity-60"}`}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      disabled={!m.ready}
                      checked={checked}
                      onChange={() => toggle(m.reviewer)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-stone-900">{m.reviewer}</span>
                        <span className="font-mono text-xs text-stone-600">{m.modelId}</span>
                        <span className="text-xs text-stone-500">
                          {providerLabel(m.provider)}
                          {m.openWeights ? " · open weights" : ""}
                          {m.reasoningEffort ? ` · effort ${m.reasoningEffort}` : ""}
                        </span>
                      </span>
                      <span className="block text-xs text-stone-500">{m.costNote}</span>
                      {!m.ready ? <span className="block text-xs text-amber-700">Not ready: {m.why}</span> : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <details className="rounded-lg border border-stone-200 bg-white p-4">
        <summary className="cursor-pointer text-sm font-medium text-stone-800">Options</summary>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <NumberField label="Seeded copies" value={copies} min={1} max={6} onChange={setCopies} />
          <NumberField label="Decoys per copy" value={perCopy} min={1} max={12} onChange={setPerCopy} />
          <NumberField label="Seed" value={seed} min={0} max={1_000_000} onChange={setSeed} />
          <label className="text-sm">
            <span className="text-stone-600">Lines (optional)</span>
            <input value={lines} onChange={(e) => setLines(e.target.value)} placeholder="10-40,55-60" className="mt-1 w-full rounded border border-stone-300 px-2 py-1 font-mono" />
          </label>
        </div>
        <label className="mt-3 block text-sm">
          <span className="text-stone-600">Note (shown on the run)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="mt-1 w-full rounded border border-stone-300 px-2 py-1" />
        </label>
      </details>

      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-white p-4">
        <div className="min-w-0 flex-1 text-sm">
          {panel.length ? (
            <>
              <div>
                <span className="font-medium">{calls} review calls</span>{" "}
                <span className="text-stone-500">
                  ({panel.length} reviewer{panel.length > 1 ? "s" : ""} × original + {copies} cop{copies > 1 ? "ies" : "y"})
                </span>
              </div>
              {estimate ? (
                <div className="text-stone-600">
                  Rough cost: ${estimate.dollars.toFixed(2)}
                  {estimate.other.length ? <span className="text-stone-500"> plus {estimate.other.join("; ")}</span> : null}
                </div>
              ) : null}
            </>
          ) : (
            <span className="text-stone-500">Select at least one reviewer.</span>
          )}
          {submitError ? <div className="mt-1 text-red-700">{submitError}</div> : null}
        </div>
        <button
          type="submit"
          disabled={busy || !panel.length}
          className="rounded bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-stone-300"
        >
          {busy ? "Starting…" : "Run"}
        </button>
      </div>
    </form>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="text-sm">
      <span className="text-stone-600">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="tabular mt-1 w-full rounded border border-stone-300 px-2 py-1"
      />
    </label>
  );
}
