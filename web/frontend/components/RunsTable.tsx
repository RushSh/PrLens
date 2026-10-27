"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { RunSummary } from "@bugcensus/shared";
import { duration, int, num, pct, when } from "@/lib/format";
import { ModelChip, Td, Th, Verdict } from "./ui";

export function RunsTable({ runs }: { runs: RunSummary[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [file, setFile] = useState("");
  const [model, setModel] = useState("");

  const files = useMemo(() => [...new Set(runs.map((r) => r.filePath))].sort(), [runs]);
  const models = useMemo(
    () => [...new Set(runs.flatMap((r) => r.models.map((m) => m.reviewer)))].sort(),
    [runs],
  );
  const shown = runs.filter(
    (r) => (!file || r.filePath === file) && (!model || r.models.some((m) => m.reviewer === model)),
  );
  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 6 ? s : [...s, id]));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm" value={file} onChange={(e) => setFile(e.target.value)}>
          <option value="">All files</option>
          {files.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        <select className="rounded border border-stone-300 bg-white px-2 py-1.5 text-sm" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">All reviewers</option>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-stone-500">{selected.length} selected</span>
          <button
            type="button"
            disabled={selected.length < 2}
            onClick={() => router.push(`/compare?ids=${selected.join(",")}`)}
            className="rounded bg-stone-900 px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-stone-300"
          >
            Compare
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className="w-full min-w-[960px]">
          <thead className="border-b border-stone-200 bg-stone-50">
            <tr>
              <Th className="w-8" />
              <Th>When</Th>
              <Th>File</Th>
              <Th>Reviewers (model · provider)</Th>
              <Th>Verdict</Th>
              <Th className="text-right">Found</Th>
              <Th className="text-right">Decoys caught</Th>
              <Th className="text-right">Still hidden</Th>
              <Th className="text-right">P(clean)</Th>
              <Th className="text-right">Output tokens</Th>
              <Th className="text-right">Time</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-stone-50">
                <Td>
                  <input
                    type="checkbox"
                    aria-label="select for comparison"
                    checked={selected.includes(r.id)}
                    onChange={() => toggle(r.id)}
                  />
                </Td>
                <Td className="whitespace-nowrap text-stone-600">
                  <Link href={`/runs/${r.id}`} className="hover:underline">
                    {when(r.finishedAt)}
                  </Link>
                  {r.note ? <div className="max-w-[16ch] truncate text-xs text-stone-500" title={r.note}>{r.note}</div> : null}
                </Td>
                <Td className="font-mono text-xs">
                  <Link href={`/runs/${r.id}`} className="hover:underline">
                    {r.filePath}
                  </Link>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {r.models.map((m) => (
                      <ModelChip key={m.reviewer} model={m} />
                    ))}
                  </div>
                </Td>
                <Td>
                  <Verdict verdict={r.verdict} hidden={r.hiddenStatus} />
                  {r.errors.length ? <div className="mt-1 text-xs text-red-700">{r.errors.length} problem{r.errors.length > 1 ? "s" : ""}</div> : null}
                </Td>
                <Td className="tabular text-right">{r.foundCounted}</Td>
                <Td className="tabular text-right">
                  {r.decoysCounted - r.decoysMissed}/{r.decoysCounted}
                  {r.decoysNotReviewed ? <div className="text-xs text-amber-700">{r.decoysNotReviewed} not reviewed</div> : null}
                </Td>
                <Td className="tabular text-right">{num(r.expectedHidden)}</Td>
                <Td className="tabular text-right">{pct(r.pClean)}</Td>
                <Td className="tabular text-right">{int(r.tokensOut)}</Td>
                <Td className="tabular whitespace-nowrap text-right">{duration(r.seconds)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">* model details inferred: the run was saved before BugCensus recorded them.</p>
    </div>
  );
}
