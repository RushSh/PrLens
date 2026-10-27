import Link from "next/link";
import { notFound } from "next/navigation";
import type { RunDetail } from "@bugcensus/shared";
import { CodeView } from "@/components/CodeView";
import { NoteEditor } from "@/components/NoteEditor";
import { Card, ModelChip, Stat, Td, Th, Verdict } from "@/components/ui";
import { ApiError, serverGet } from "@/lib/api";
import { duration, int, num, pct, when } from "@/lib/format";
import { providerLabel } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let run: RunDetail;
  try {
    run = await serverGet<RunDetail>(`/api/runs/${id}`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }

  const caught = run.decoysCounted - run.decoysMissed;
  const settings = run.settings as { n_copies?: number; per_copy?: number; seed?: number; line_ranges?: number[][] | null };
  const copies = [...new Set(run.decoys.map((d) => d.copyName))];
  const versions = [...new Set(run.reviews.map((r) => r.version))];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-stone-500">
            <Link href="/" className="hover:underline">Runs</Link> / {when(run.finishedAt)}
          </div>
          <h1 className="truncate font-mono text-lg font-semibold text-stone-900">{run.filePath}</h1>
          <div className="mt-1 flex flex-wrap gap-1">
            {run.models.map((m) => (
              <ModelChip key={m.reviewer} model={m} detail />
            ))}
          </div>
        </div>
        <Verdict verdict={run.verdict} hidden={run.hiddenStatus} />
      </div>

      {run.errors.length ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <div className="font-semibold">Problems in this run</div>
          <ul className="mt-1 list-disc pl-5">
            {run.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {run.metadataInferred ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Saved before BugCensus recorded model details (Oct 27). Models are the defaults of that time and
          per-review numbers come from the usage log, so treat them as approximate.
        </div>
      ) : null}

      <Card>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
          <Stat label="Suspected bugs found" value={run.foundCounted} sub={run.foundIsVerified ? "verified" : "unverified"} />
          <Stat
            label="Decoys caught"
            value={`${caught}/${run.decoysCounted}`}
            sub={run.decoysNotReviewed ? `${run.decoysNotReviewed} not reviewed` : undefined}
          />
          <Stat
            label="Still hidden (est.)"
            value={num(run.expectedHidden)}
            sub={run.intervalLow !== null ? `90% interval ${run.intervalLow}–${run.intervalHigh}` : undefined}
          />
          <Stat label="P(clean)" value={pct(run.pClean)} />
          <Stat label="Panel blind rate" value={pct(run.qMean, 1)} sub="share of bugs every reviewer misses" />
          <Stat label="Tokens" value={int(run.tokensOut)} sub={`${int(run.tokensIn)} in`} />
          <Stat label="Time" value={duration(run.seconds)} />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="What was tested">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-stone-500">File</dt>
            <dd className="font-mono text-xs">{run.filePath}</dd>
            <dt className="text-stone-500">Lines in scope</dt>
            <dd>
              {run.changedLines ?? "–"}
              {settings.line_ranges ? ` (${settings.line_ranges.map((r) => r.join("–")).join(", ")})` : " (whole file)"}
            </dd>
            <dt className="text-stone-500">Seeded copies</dt>
            <dd>{settings.n_copies !== undefined ? `${settings.n_copies} copies × up to ${settings.per_copy} decoys, seed ${settings.seed}` : "–"}</dd>
            <dt className="text-stone-500">Code version</dt>
            <dd className="font-mono text-xs">{run.gitSha ?? "not recorded"}</dd>
            <dt className="text-stone-500">Review prompt</dt>
            <dd className="font-mono text-xs">{run.promptSha ?? "not recorded"}</dd>
            <dt className="text-stone-500">Run id</dt>
            <dd className="font-mono text-xs">{run.runKey}</dd>
          </dl>
          <div className="mt-3 border-t border-stone-100 pt-3">
            <NoteEditor runId={run.id} initial={run.note} />
          </div>
        </Card>

        <Card title="Who tested it">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200">
                  <Th>Reviewer</Th>
                  <Th>Model</Th>
                  <Th>Provider</Th>
                  <Th>Effort</Th>
                  <Th>Token cap</Th>
                </tr>
              </thead>
              <tbody>
                {run.models.map((m) => (
                  <tr key={m.reviewer} className="border-b border-stone-100">
                    <Td className="font-medium">{m.reviewer}{m.inferred ? "*" : ""}</Td>
                    <Td className="font-mono text-xs">{m.modelId}</Td>
                    <Td>
                      {providerLabel(m.provider)}
                      {m.endpoint ? <div className="text-xs text-stone-500">{m.endpoint}</div> : null}
                      {m.openWeights ? <div className="text-xs text-stone-500">open weights</div> : null}
                    </Td>
                    <Td>{m.reasoningEffort ?? "model default"}</Td>
                    <Td className="tabular">{m.maxTokens ? int(m.maxTokens) : "–"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <Card title="Review calls" right={<span className="text-xs text-stone-500">one fresh call per reviewer per version</span>}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-stone-200">
                <Th>Reviewer</Th>
                <Th>Version</Th>
                <Th className="text-right">Findings</Th>
                <Th className="text-right">Tokens in</Th>
                <Th className="text-right">Tokens out</Th>
                <Th className="text-right">Time</Th>
                <Th>Result</Th>
              </tr>
            </thead>
            <tbody>
              {run.reviews.map((r, i) => (
                <tr key={i} className={`border-b border-stone-100 ${r.error ? "bg-red-50/60" : ""}`}>
                  <Td className="font-medium">{r.reviewer}</Td>
                  <Td>{r.version}</Td>
                  <Td className="tabular text-right">{r.findingsCount ?? "–"}</Td>
                  <Td className="tabular text-right">{int(r.inputTokens)}</Td>
                  <Td className="tabular text-right">{int(r.outputTokens)}</Td>
                  <Td className="tabular text-right">{duration(r.seconds)}</Td>
                  <Td className={r.error ? "text-red-800" : "text-stone-600"}>
                    {r.error ?? (r.finishReason ?? "ok")}
                    {r.inferred ? <span className="text-stone-400"> (from usage log)</span> : null}
                  </Td>
                </tr>
              ))}
              {!run.reviews.length ? (
                <tr>
                  <Td className="text-stone-500">No per-call records for this run.</Td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title={`Suspected bugs (original version): ${run.suspectedBugs.length}`}>
        {run.suspectedBugs.length ? (
          <ul className="space-y-2">
            {run.suspectedBugs.map((b, i) => (
              <li key={i} className="rounded border border-orange-200 bg-orange-50/50 p-2.5 text-sm">
                <div className="text-xs text-stone-500">
                  lines {b.startLine}–{b.endLine} · {b.reviewers.join(", ")}
                </div>
                {b.explanations.map((e, j) => (
                  <p key={j} className="mt-0.5">{e}</p>
                ))}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-stone-500">None.</p>
        )}
      </Card>

      <Card title="Decoys" right={<span className="text-xs text-stone-500">planted in copies; reviewers never knew</span>}>
        <div className="space-y-4">
          {copies.map((c) => (
            <div key={c}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">{c}</h3>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-stone-200">
                      <Th>Outcome</Th>
                      <Th>Family</Th>
                      <Th>Where</Th>
                      <Th>Change</Th>
                      <Th>Matching finding</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.decoys
                      .filter((d) => d.copyName === c)
                      .map((d, i) => {
                        const change = d.description.split(": ").slice(1).join(": ");
                        return (
                          <tr key={i} className="border-b border-stone-100">
                            <Td>
                              {d.notReviewed ? (
                                <span className="text-amber-700">not reviewed</span>
                              ) : d.caughtBy.length ? (
                                <span className="text-emerald-700">caught by {d.caughtBy.join(", ")}</span>
                              ) : (
                                <span className="font-medium text-red-700">missed</span>
                              )}
                            </Td>
                            <Td>{d.kind ?? "–"}</Td>
                            <Td className="whitespace-nowrap font-mono text-xs">
                              {d.functionName}() line {d.line}
                              {d.lineInCopy && d.lineInCopy !== d.line ? <span className="text-stone-400"> (copy line {d.lineInCopy})</span> : null}
                            </Td>
                            <Td className="font-mono text-xs">{change}</Td>
                            <Td className="text-xs text-stone-600">
                              {d.matched[0]?.explanation ?? null}
                              {!d.matched.length && d.tooWide.length ? (
                                <span className="text-amber-700">only a too-wide finding (lines {d.tooWide[0]!.lines.join("–")}) covered it</span>
                              ) : null}
                            </Td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {!copies.length ? <p className="text-sm text-stone-500">No decoys were planted.</p> : null}
        </div>
      </Card>

      {run.source ? (
        <Card title="Code (original)" right={<span className="text-xs text-stone-500">orange: suspected bug · green/red: decoy caught/missed (in a copy)</span>}>
          <CodeView source={run.source} bugs={run.suspectedBugs} decoys={run.decoys} />
        </Card>
      ) : null}

      {run.findings.length ? (
        <Card title={`All findings (${run.findings.length})`}>
          <div className="space-y-3">
            {versions.map((v) => {
              const fs = run.findings.filter((f) => f.version === v);
              return (
                <details key={v} open={v === "original"}>
                  <summary className="cursor-pointer text-sm font-medium">
                    {v} <span className="text-stone-500">({fs.length})</span>
                  </summary>
                  <ul className="mt-1 space-y-1 pl-4 text-sm">
                    {fs.map((f, i) => (
                      <li key={i}>
                        <span className="font-mono text-xs text-stone-500">
                          {f.reviewer} · {f.startLine}–{f.endLine}
                          {f.endLine - f.startLine + 1 > 6 ? " (too wide to count)" : ""}
                        </span>{" "}
                        {f.explanation}
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
