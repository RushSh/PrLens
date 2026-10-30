import Link from "next/link";
import { EVAL_LANGUAGES, type EvalLanguage, type TriageSetInfo } from "@prlens/shared";
import { DriftChart } from "@/components/DriftChart";
import { EvalChart } from "@/components/EvalChart";
import { Box, Counter, Empty, Pill, Stat } from "@/components/ui";
import { pct, when } from "@/lib/format";
import { loadEvalSets } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

type Sets = Record<EvalLanguage, TriageSetInfo | null>;

export default async function EvaluationPage({ searchParams }: { searchParams: Promise<{ lang?: string }> }) {
  const { lang } = await searchParams;
  const sets = await loadEvalSets();
  const published = EVAL_LANGUAGES.filter((l) => sets[l.key]?.evaluation);
  if (!published.length) {
    return (
      <Empty>
        No evaluation set yet. Run <span className="font-mono">prlens export</span> (or “Publish the evaluation set” on{" "}
        <Link href="/pipeline" className="text-accent hover:underline">Pipeline</Link>).
      </Empty>
    );
  }
  const current = EVAL_LANGUAGES.find((l) => l.key === lang) ?? published[0]!;
  const set = sets[current.key];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">How well PR Lens triages</h1>
        <p className="mt-1 max-w-3xl text-muted">
          Real commits from open-source repositories, each of which introduced a bug that a later commit fixed. Every fix comes
          with tests that fail before it and pass after. PR Lens triaged each commit without knowing where the bug was; the
          question is whether the bug stayed in what a human reads. Each language is calibrated and measured on its own.
        </p>
      </div>

      <Languages sets={sets} />

      <nav className="flex overflow-x-auto border-b border-line" aria-label="Language">
        {EVAL_LANGUAGES.map((l) => {
          const active = l.key === current.key;
          const s = sets[l.key];
          return (
            <Link
              key={l.key}
              href={`/evaluation?lang=${l.key}`}
              aria-current={active ? "page" : undefined}
              className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${
                active ? "border-[#fd8c73] font-semibold text-fg" : "border-transparent text-muted hover:border-line hover:text-fg"
              }`}
            >
              {l.label}
              {s?.evaluation ? <Counter>{s.summary.prs}</Counter> : <span className="text-xs">· not scored yet</span>}
            </Link>
          );
        })}
      </nav>

      {set?.evaluation ? (
        <SetDetail set={set} label={current.label} />
      ) : (
        <Empty>
          The {current.label} evaluation set is not published yet: its bugs are confirmed and traced, and its regions are waiting
          for model scores. Then <span className="font-mono">prlens fit --language {current.key} --save</span> and{" "}
          <span className="font-mono">prlens export --language {current.key}</span> publish it here.
        </Empty>
      )}
    </div>
  );
}

/** One row per language: the headline numbers side by side. */
function Languages({ sets }: { sets: Sets }) {
  return (
    <Box title="Across languages">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-4 py-2 font-medium">Language</th>
              <th className="px-4 py-2 text-right font-medium">PRs</th>
              <th className="px-4 py-2 text-right font-medium">Repositories</th>
              <th className="px-4 py-2 text-right font-medium">Bug kept for review</th>
              <th className="px-4 py-2 text-right font-medium">Lines left to read</th>
              <th className="px-4 py-2 text-right font-medium">Held out by repo</th>
              <th className="px-4 py-2 text-right font-medium">AUC (model alone)</th>
            </tr>
          </thead>
          <tbody>
            {EVAL_LANGUAGES.map((l) => {
              const s = sets[l.key];
              const ev = s?.evaluation;
              return (
                <tr key={l.key} className="border-b border-line-muted last:border-b-0">
                  <td className="px-4 py-2">
                    <Link href={`/evaluation?lang=${l.key}`} className="font-semibold text-fg hover:text-accent">
                      {l.label}
                    </Link>
                  </td>
                  {s && ev ? (
                    <>
                      <td className="tabular px-4 py-2 text-right">{s.summary.prs}</td>
                      <td className="tabular px-4 py-2 text-right">{s.summary.repos}</td>
                      <td className="tabular px-4 py-2 text-right">
                        <span className="font-semibold text-fg">{pct((s.summary.prs - s.summary.missed) / s.summary.prs)}</span>{" "}
                        <span className="text-muted">({s.summary.prs - s.summary.missed}/{s.summary.prs})</span>
                      </td>
                      <td className="tabular px-4 py-2 text-right">{pct(s.summary.read_share)}</td>
                      <td className="tabular px-4 py-2 text-right">
                        {s.summary.held_out_missed} skipped, {pct(s.summary.held_out_read_share)} read
                      </td>
                      <td className="tabular px-4 py-2 text-right">
                        {ev.auc.combined.toFixed(2)} <span className="text-muted">({ev.auc.model.toFixed(2)})</span>
                      </td>
                    </>
                  ) : (
                    <td colSpan={6} className="px-4 py-2 text-right text-muted">
                      <Pill>not scored yet</Pill>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Box>
  );
}

function SetDetail({ set, label }: { set: TriageSetInfo; label: string }) {
  const s = set.summary;
  const ev = set.evaluation!;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-muted">
        {label}: {s.prs} commits from {s.repos} repositories. Generated {when(set.generatedAt)} with {set.model}.
      </p>

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
              Bugs are real: each fix&apos;s tests were run, and they fail before the fix and pass after
              {label === "Python" ? " (one of 111 Python fixes could not be run in our test environment)" : ""}. The commit
              that introduced the bug is found by tracing the fixed lines back ({ev.evidence.deleted} from changed lines,{" "}
              {ev.evidence.adjacent} from where the fix added code, which is weaker evidence).
            </li>
            <li>
              Scores are out of fold: each PR is scored by a combiner fit without its repository. The threshold is chosen on all
              PRs; the held-out figure above chooses it without the repository too.
            </li>
            <li>
              PR sizes: median {ev.pr_lines.median} changed lines, 75% under {ev.pr_lines.p75}, largest {ev.pr_lines.max}.
            </li>
            {ev.auc.combined <= ev.auc.model ? (
              <li>
                On these PRs the combiner does not rank better than the model alone (AUC {ev.auc.combined.toFixed(2)} vs{" "}
                {ev.auc.model.toFixed(2)}). The skip promise still holds: the threshold is calibrated on these PRs either way.
              </li>
            ) : null}
            <li>
              The combiner and threshold for {label} are fit on {label} PRs only; no language borrows another&apos;s calibration.
              The promise covers functional bugs in {label}.
            </li>
            <li>Most of these commits were written by people; how it holds on AI-written PRs is the next test.</li>
          </ul>
        </Box>
      </div>
    </div>
  );
}
