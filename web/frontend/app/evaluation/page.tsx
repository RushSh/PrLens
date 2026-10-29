import Link from "next/link";
import { DriftChart } from "@/components/DriftChart";
import { EvalChart } from "@/components/EvalChart";
import { Box, Empty, Pill, Stat } from "@/components/ui";
import { pct, when } from "@/lib/format";
import { loadEvalSet } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

export default async function EvaluationPage() {
  const set = await loadEvalSet();
  if (!set?.evaluation) {
    return (
      <Empty>
        No evaluation set yet. Run <span className="font-mono">prlens export</span> (or “Publish the evaluation set” on{" "}
        <Link href="/pipeline" className="text-accent hover:underline">Pipeline</Link>).
      </Empty>
    );
  }
  const s = set.summary;
  const ev = set.evaluation;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">How well PR Lens triages</h1>
        <p className="mt-1 max-w-3xl text-muted">
          {s.prs} real commits from {s.repos} open-source repositories, each of which introduced a bug that a later commit fixed.
          PR Lens triaged each one without knowing where the bug was; the question is whether the bug stayed in what a human
          reads. Generated {when(set.generatedAt)} with {set.model}.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-md border border-line p-4 md:grid-cols-4">
        <Stat label="Bug kept for review" value={`${s.prs - s.missed} / ${s.prs}`} sub={`${pct((s.prs - s.missed) / s.prs)} of PRs`} />
        <Stat label="Lines left to read" value={pct(s.read_share)} sub="of all changed lines" />
        <Stat label="Held out by repository" value={`${s.held_out_missed} / ${s.prs} skipped`} sub={`reading ${pct(s.held_out_read_share)}; threshold set without the repo`} />
        <Stat label="Ranking quality (AUC)" value={ev.auc.combined.toFixed(2)} sub={`model alone ${ev.auc.model.toFixed(2)}; 0.5 = chance`} />
      </div>

      <Box title="Reading less vs missing bugs">
        <div className="p-4">
          <EvalChart ev={ev} chosen={{ read: s.read_share, missed: s.missed }} prs={s.prs} />
          <p className="mt-2 text-sm text-muted">
            Each point is a skip threshold. PR Lens uses the highest one whose 90% upper bound on the miss rate stays under{" "}
            {pct(ev.alpha)} (Clopper-Pearson, {s.prs} PRs). Reading the riskiest regions first, the bug is in the first quarter of
            lines {pct(ev.gate.quarter)} of the time, the first third {pct(ev.gate.third)}, the first half {pct(ev.gate.half)}.
          </p>
        </div>
      </Box>

      {ev.drift ? (
        <Box title="A promise that survives drift: the adaptive threshold">
          <div className="grid gap-6 p-4 xl:grid-cols-[minmax(0,1fr)_340px]">
            <DriftChart drift={ev.drift} />
            <div className="space-y-3 text-sm text-fg">
              <p>
                A threshold calibrated once breaks when new PRs differ from old ones: replayed in date order, the fixed threshold
                skips {pct(ev.drift.date.fixed[ev.drift.date.fixed.length - 1] ?? 0)} of bugs, against a promised {pct(ev.alpha)}.
              </p>
              <p>
                PR Lens moves each repository&apos;s threshold after every reviewed PR (adaptive conformal inference, Gibbs &amp;
                Candès 2021): a bug found in skipped code tightens it, a clean review loosens it a little.
              </p>
              <div className="rounded-md border border-line bg-subtle p-3 font-mono text-xs leading-6">
                θ<sub>t+1</sub> = θ<sub>t</sub> − η (err<sub>t</sub> − α)
                <br />
                miss rate after n PRs ≤ α + (θ<sub>1</sub> − logit(floor) + η(1−α)) / (η n)
              </div>
              <p className="text-muted">
                The ceiling holds for every sequence of PRs, drifting or adversarial, with no assumption that the future looks
                like the past. Here α = {pct(ev.drift.date.alpha)}, η = {ev.drift.date.eta}, floor = {pct(ev.drift.date.floor, 1)}: after{" "}
                {ev.drift.date.prs} PRs the ceiling is {pct(ev.drift.date.bound[ev.drift.date.bound.length - 1] ?? 1)}, after 200 it is
                23%, and it keeps falling toward {pct(ev.alpha)}. Assumes each outcome is reported before the next PR is triaged and
                that the no-model skips (proven formatting, docs, lock files) hold no functional bug.
              </p>
            </div>
          </div>
        </Box>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Box title="By repository">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-medium">Repository</th>
                <th className="px-4 py-2 text-right font-medium">PRs</th>
                <th className="px-4 py-2 text-right font-medium">Bug skipped</th>
                <th className="px-4 py-2 text-right font-medium">Lines read</th>
              </tr>
            </thead>
            <tbody>
              {ev.by_repo.map((r) => (
                <tr key={r.repo} className="border-b border-line-muted last:border-b-0">
                  <td className="px-4 py-1.5 font-mono text-xs">{r.repo}</td>
                  <td className="tabular px-4 py-1.5 text-right">{r.prs}</td>
                  <td className={`tabular px-4 py-1.5 text-right ${r.missed ? "text-danger" : "text-muted"}`}>{r.missed}</td>
                  <td className="tabular px-4 py-1.5 text-right">{pct(r.read_share)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Box>

        <Box title="What this does and does not show">
          <ul className="list-disc space-y-2 py-3 pl-8 pr-4 text-sm text-fg">
            <li>
              Bugs are real: each fix comes with tests that fail before it and pass after. The commit that introduced the bug is
              found by tracing the fixed lines back ({ev.evidence.deleted} from changed lines, {ev.evidence.adjacent} from where
              the fix added code, which is weaker evidence).
            </li>
            <li>
              Scores are out of fold: each PR is scored by a combiner fit without its repository. The threshold is chosen on all
              PRs; the held-out figure above chooses it without the repository too.
            </li>
            <li>
              PR sizes: median {ev.pr_lines.median} changed lines, 75% under {ev.pr_lines.p75}, largest {ev.pr_lines.max}.
            </li>
            <li>
              Languages:{" "}
              {Object.entries(ev.languages).map(([k, v]) => (
                <Pill key={k} tone="accent">
                  {k} · {v}
                </Pill>
              ))}{" "}
              <Pill>TypeScript · in progress</Pill> <Pill>C# · in progress</Pill>. The promise covers functional bugs in Python
              until those sets exist.
            </li>
            <li>Most of these commits were written by people; how it holds on AI-written PRs is the next test.</li>
          </ul>
        </Box>
      </div>
    </div>
  );
}
