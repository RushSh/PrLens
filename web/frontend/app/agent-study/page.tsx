import Link from "next/link";
import { EVAL_LANGUAGES } from "@prlens/shared";
import { AgentIcon, CheckIcon, XIcon } from "@/components/Icons";
import { Box, Empty, Pill, Stat } from "@/components/ui";
import { pct, when } from "@/lib/format";
import { prHref } from "@/lib/pr";
import { loadEvalSet } from "@/lib/triage-source";

export const dynamic = "force-dynamic";

const OUTCOMES = [
  { key: "fixed", label: "fix tests pass", match: (s?: string | null) => s === "fixed" },
  { key: "partly", label: "fewer fail", match: (s?: string | null) => s === "partly fixed" },
  { key: "not", label: "still fail", match: (s?: string | null) => s === "not fixed" },
  { key: "none", label: "no change", match: (s?: string | null) => s === "no change" },
  { key: "other", label: "not judged", match: (s?: string | null) => s === "apply_failed" || s === "not_loading" },
];

const ARMS = [
  { key: "flagged", label: "Round 1, with PR Lens's flags" },
  { key: "blind", label: "Round 1, control (no flags)" },
  { key: "flagged2", label: "Round 2, with flags (whole-PR notes, softer prompt)" },
  { key: "blind2", label: "Round 2, control (softer prompt)" },
];

const langLabel = (k: string) => EVAL_LANGUAGES.find((l) => l.key === k)?.label ?? k;

export default async function AgentStudyPage() {
  const set = await loadEvalSet("agent");
  const study = set?.summary.agentStudy;
  if (!set || !study) {
    return (
      <Empty>
        The agent study is not published yet. After <span className="font-mono">prlens agent-study validate</span>, run{" "}
        <span className="font-mono">prlens agent-study triage --yes</span> to score the agent&apos;s PRs; the backend imports the result.
      </Empty>
    );
  }
  const bugs = study.tasks.filter((t) => t.verdict === "bug");
  const kept = bugs.filter((t) => t.caught).length;
  const read = study.tasks.reduce((a, t) => a + t.read, 0);
  const lines = study.tasks.reduce((a, t) => a + t.lines, 0);
  const top = study.funnel[0]?.prs ?? 1;
  const omissions = bugs.filter((t) => t.bugKind === "omission").length;
  const suggested = study.tasks.filter((t) => t.suggestionRounds && Object.keys(t.suggestionRounds).length);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-fg">Agent study: PR Lens on {study.agent}&apos;s pull requests</h1>
        <p className="mt-1 max-w-3xl text-muted">
          Agents write more code than teams can read, so the question is whether the triage holds on agent-written PRs. The{" "}
          {study.agent} agent ({study.model}) got {top} evaluation commits to re-implement: a snapshot of each repository at the
          commit&apos;s parent, with no later history, and the commit message as the task. The later fix&apos;s own tests then
          judged its change. Where a fix test failed, the bug region was labelled by hand, and PR Lens triaged the PR without
          seeing the label. This is a case study with an honest count, not a calibrated claim.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 rounded-md border border-line p-4 md:grid-cols-4">
        <Stat label="Agent PRs with a confirmed bug" value={`${bugs.length} / ${study.tasks.length}`} sub="judgeable PRs" />
        <Stat label="Bug kept for review" value={`${kept} / ${bugs.length}`} sub={bugs.length ? `${pct(kept / bugs.length)} of agent bugs` : undefined} />
        <Stat label="Lines left to read" value={pct(lines ? read / lines : 0)} sub={`${read} of ${lines} changed lines`} />
        <Stat label="Bugs that were omissions" value={`${omissions} / ${bugs.length}`} sub="missing behaviour, not wrong new code" />
      </div>

      <Box title="Funnel">
        <ol className="space-y-2 p-4">
          {study.funnel.map((f, i) => (
            <li key={f.stage} className="grid grid-cols-[minmax(0,1fr)_3rem] items-center gap-3 text-sm sm:grid-cols-[minmax(0,22rem)_minmax(0,1fr)_3rem]">
              <span className={i === study.funnel.length - 1 ? "font-semibold text-fg" : "text-fg"}>{f.stage}</span>
              <span className="hidden h-2.5 overflow-hidden rounded-full bg-line-muted sm:block" aria-hidden>
                <span
                  className={`block h-2.5 rounded-full ${i === study.funnel.length - 1 ? "bg-success-emph" : "bg-accent"}`}
                  style={{ width: `${(f.prs / top) * 100}%` }}
                />
              </span>
              <span className="tabular text-right font-semibold text-fg">{f.prs}</span>
            </li>
          ))}
        </ol>
        <p className="border-t border-line px-4 py-2.5 text-sm text-muted">
          The drop from attempted to judgeable is about old projects, not the agent: a fix&apos;s tests have to load against the
          parent commit, with that era&apos;s dependencies and toolchain. Every exclusion and its reason is listed below.
        </p>
      </Box>

      {suggested.length ? (
        <Box title="Closing the loop: can Muse Code fix what PR Lens flagged?">
          <div className="space-y-3 px-4 py-3 text-sm">
            <p className="text-fg">
              For each bug PR Lens kept for review, {study.agent} got the same task and its own change twice: once with the regions
              PR Lens flagged and Muse Spark&apos;s notes and questions, once without them (the control). It never saw the bug, the
              later fix or its tests; the later fix&apos;s tests judged both. Round 2 softened the request the same way in both arms
              and used notes that see the whole PR. {suggested.length} PRs is a case study: read the counts, not a rate.
            </p>
            <table className="w-full max-w-xl text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-1.5 pr-3 font-normal" />
                  {OUTCOMES.map((o) => (
                    <th key={o.key} className="py-1.5 pr-3 text-right font-normal">{o.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ARMS.filter((a) => suggested.some((t) => t.suggestionRounds?.[a.key])).map((a) => {
                  const ran = suggested.filter((t) => t.suggestionRounds?.[a.key]);
                  return (
                    <tr key={a.key} className="border-b border-line-muted last:border-b-0">
                      <td className="py-1.5 pr-3 text-fg">{a.label}</td>
                      {OUTCOMES.map((o) => (
                        <td key={o.key} className="tabular py-1.5 pr-3 text-right">
                          {ran.filter((t) => o.match(t.suggestionRounds?.[a.key])).length}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-muted">
              Every suggestion is labelled “suggested, still needs human review”; PR Lens never applies one. Where the project&apos;s
              own Python suite runs, each suggestion is also checked for tests it newly breaks.
            </p>
          </div>
        </Box>
      ) : null}

      <Box title={`The ${study.tasks.length} judgeable agent PRs`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-4 py-2 font-normal">Task, and where the bug was (labelled by hand)</th>
                <th className="px-4 py-2 font-normal">Fix tests</th>
                <th className="px-4 py-2 text-right font-normal">Lines read</th>
                <th className="px-4 py-2 font-normal">PR Lens</th>
                <th className="px-4 py-2 font-normal">Muse Code fix</th>
              </tr>
            </thead>
            <tbody>
              {study.tasks.map((t) => (
                <tr key={t.task} className="border-b border-line-muted align-top last:border-b-0">
                  <td className="px-4 py-2">
                    <Link href={prHref(t.prId, "files")} className="inline-flex items-center gap-1.5 font-mono text-accent hover:underline">
                      <AgentIcon size={14} className="shrink-0" />
                      {t.task}
                    </Link>
                    {t.why.length ? <p className="mt-0.5 max-w-xl text-xs text-muted">{t.why.join(" ")}</p> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {t.verdict === "bug" ? (
                      <Pill tone="danger" title={t.bugKind === "omission" ? "The parent fails the same tests: the change left out behaviour the fix required" : "The failure is in code the agent wrote"}>
                        bug · {t.bugKind}
                      </Pill>
                    ) : (
                      <Pill tone="success">pass</Pill>
                    )}
                  </td>
                  <td className="tabular px-4 py-2 text-right text-muted">
                    <span className="font-semibold text-fg">{t.read}</span> / {t.lines}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {t.caught === true ? (
                      <span className="inline-flex items-center gap-1 text-success"><CheckIcon size={14} /> kept for review</span>
                    ) : t.caught === false ? (
                      <span className="inline-flex items-center gap-1 text-danger"><XIcon size={14} /> skipped</span>
                    ) : (
                      <span className="text-muted">no bug to keep</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {t.suggestion ? (
                      <span className={t.suggestion === "fixed" ? "text-success" : t.suggestion === "partly fixed" ? "text-attention" : "text-muted"}>
                        {t.suggestion}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                    {t.suggestionBlind ? <span className="block text-xs text-muted">control: {t.suggestionBlind}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Box>

      <Box title={`Not judgeable (${study.notJudgeable.length})`}>
        <ul className="divide-y divide-line-muted text-sm">
          {study.notJudgeable.map((n) => (
            <li key={n.task} className="flex flex-wrap gap-x-3 px-4 py-2">
              <span className="w-56 shrink-0 font-mono text-fg">{n.task}</span>
              <span className="w-24 shrink-0 text-muted">{langLabel(n.language)}</span>
              <span className="min-w-0 flex-1 text-muted">{n.why}</span>
            </li>
          ))}
        </ul>
      </Box>

      <Box title="Read this before quoting the numbers">
        <ul className="list-disc space-y-1.5 py-3 pl-9 pr-4 text-sm text-muted">
          <li>
            {bugs.length} bugs is a small sample: {kept} of {bugs.length} kept is evidence the triage carries over to agent-written
            code, not a measured rate. The calibrated miss rate comes from the evaluation set.
          </li>
          <li>
            The skip threshold and combiner were fit on human-written commits in each language; nothing here was tuned on the
            agent&apos;s PRs.
          </li>
          <li>
            Bug regions were labelled by hand with one rule: the region of the agent&apos;s change that the human fix had to
            change. An omission whose fix lands outside the PR has no region and would count as skipped.
          </li>
          <li>
            The agent&apos;s PRs are small ({study.tasks.map((t) => t.lines).sort((a, b) => a - b)[0]}–
            {Math.max(...study.tasks.map((t) => t.lines))} changed lines), so the reading saved per PR is modest; the
            evaluation set has the size spread.
          </li>
        </ul>
      </Box>

      <p className="text-xs text-muted">
        Generated {when(set.generatedAt)}; regions scored with {set.model}, combined and thresholded with each language&apos;s
        evaluation-set fit.
      </p>
    </div>
  );
}
