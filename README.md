# PR Lens

**A review budget for AI-agent merges.**

AI agents now write pull requests faster than people can read them, and AI reviewers comment on what they find. None of
them tells the human what is safe *not* to read, and an AI reviewer's silence is not a guarantee. PR Lens splits every PR
into regions of up to about 25 changed lines and puts each in one of two places:

- **Needs a human**: a risk score, a priority (P0-P2) and a one-sentence note on what to check, shown inline as a
  review comment on the exact lines, plus rules that always ask for a human (migrations, security-sensitive code,
  changed or removed public signatures, removed error handling, text addressed to an AI reviewer).
- **Skipped**: collapsed in place with its reason: docs, formatting-only changes (proven: the syntax tree is unchanged),
  lock files, generated code, config, test data, or a combined risk score under a threshold calibrated on real bugs.

The skip threshold is a dial, not a guarantee: it targets a 20% miss rate. Chosen without each PR's own repository,
16.7% of Python bugs (28 of 168) landed in skipped code, 90% upper bound 20.9%; TypeScript 14.3% (bound 20.4%);
C# 10.9% (bound 17.7%). It prioritizes human review; it never approves or merges anything.

**Three Meta AI tools, one job each.** The **Muse Code** agent writes the pull request; **Muse Spark Open** (open weights,
on Baseten) scores every region as structured JSON; the **Muse Spark Model API** writes the one-line note on what
to check. On 10 agent-written bugs from Muse Code (9 behaviours it left out, as the human author had, and 1 bug in code it
wrote), PR Lens kept 8 in the review list while leaving 27% of lines to read — a case study, not a calibrated rate.

Built for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie
Developer track). The code was written with Claude Code as a coding assistant; the product itself runs on the Meta
models above.

## Results so far (Nov 1 2026)

316 real commits from 58 open-source libraries in three languages, each of which introduced a bug that a later commit
fixed (the fix's own tests fail before it and pass after). PR Lens triaged each without knowing where the bug was. Each
language is fitted and calibrated on its own; every number is out of fold (a repository is never scored by a fit that
saw it).

| | Python | TypeScript | C# |
| --- | --- | --- | --- |
| PRs (repositories) | 168 (27) | 84 (14) | 64 (17) |
| Bug kept in the review list | 142 of 168 | 73 of 84 | 56 of 64 |
| Lines left to read | 44% | 41% | 40% |
| Threshold chosen without the PR's repository | 28 skipped, 44% read | 12 skipped, 42% read | 7 skipped, 41% read |
| Ranking quality (AUC), combined / model alone | 0.81 / 0.74 | 0.83 / 0.76 | 0.74 / 0.70 |

**Does the model earn its place?** At the same 20% miss target, held out by repository, the share of lines left to read,
and how many bugs each ranking keeps when it may read only as much as PR Lens does:

| Ranking | Python read | Python kept | TypeScript read | TypeScript kept | C# read | C# kept |
| --- | --- | --- | --- | --- | --- | --- |
| Random skipping | 76% | 85 | 70% | 47 | 80% | 30 |
| Logic density alone | 63% | 95 | 65% | 54 | 67% | 30 |
| Code features, no model | 49% | 132 | 42% | 73 | 41% | 55 |
| Spark Open alone | 53% | 134 | 42% | 71 | 55% | 46 |
| **PR Lens (combined)** | **44%** | **142** | **42%** | **73** | **41%** | **56** |

The honest reading: cheap code features do most of the work. Adding Spark Open saves about 5 points of reading in Python
and keeps 10 more of the 168 bugs at the same budget; in TypeScript and C# it ties code features. The scores are
calibrated (expected calibration error 0.9% Python, 1.2% TypeScript, 1.5% C#). Resampling whole repositories puts the
90th-percentile miss rate at 20.2% / 18.0% / 19.7%: the 20% target holds roughly, not with room to spare, when
repositories are the unit.

**On agent-written PRs.** The Muse Code agent (muse-spark-1.3-contributor) re-implemented 25 evaluation commits from a
snapshot of each commit's parent and its message. The fix's own tests could judge 11 of its PRs. In 10 a fix test fails:
9 are behaviours Muse Code left out, as the human author had, and 1 is a bug in code it wrote (more-itertools, kept for
review); in the 11th Muse Code avoided the human's bug. PR Lens kept 8 of the 10 in the review list while leaving 27% of
lines to read; both misses are TypeScript regions scored just under the threshold. A case study, not a calibrated rate
(Agent study tab).

We also tried closing the loop: for each of the 8 kept bugs, Muse Code got its own change back with PR Lens's flagged
regions and Muse Spark's notes and questions (never the bug or the later fix) and was asked for the smallest fix; as a
control, it got the same change and request with no flags. The later fix's tests judged every suggestion.

| Fix tests pass after the suggestion (of 8) | With PR Lens's flags | Control, no flags |
| --- | --- | --- |
| Round 1 | 1 | 2 |
| Round 2: notes see the whole PR; both arms asked more firmly to find a bug | 2 | 2 |

The same two bugs were fixed whenever any were (more-itertools `seekable`, sqlglot `COUNT(*) FILTER`), with and without
the flags. No suggestion broke a test that passed before: every Python suggestion was also run against the project's
own test suite (161 to about 62,000 tests) with and without it; the one TypeScript project's suite was not checked. On these 8 PRs the flags
did not change whether Muse Code could repair the bug, even when the note named it (more-itertools `iter_index`).
PR Lens's value is in what a human reads, not in steering an agent's repair.

Caveats: most evaluation commits were written by people and are small (median 135 changed lines). The Evaluation tab
shows the full curves, per-repository results, the ablation and the calibration chart.

## A promise that survives drift

A threshold calibrated once is right only while new PRs look like the old ones. PR Lens moves each repository's
threshold whenever a bug surfaces: a bug in skipped code tightens it, a bug in code it sent to review loosens it, and a
PR with no bug leaves it alone (each PR counts once):

    theta_{t+1} = theta_t - eta * (err_t - alpha)        (threshold = sigmoid(theta); adaptive conformal inference)

For every sequence of PRs, drifting or even adversarial, the share of the n surfaced bugs that sat in skipped code is at
most `alpha + (theta_1 - logit(floor) + eta*(1 - alpha)) / (eta*n)`, which falls toward 20% as n grows (proof in
`src/prlens/adaptive.py`; the tests check it against an adversary).

| Replay of the Python evaluation PRs (153 after a 15-PR warm-up) | Fixed threshold | Adaptive threshold |
| --- | --- | --- |
| Hardest repositories last | 46% of bugs skipped | 23% skipped (proven ceiling 25%) |
| Date order | 0% skipped, but 82% of lines read | 16% skipped, 50% of lines read |
| 200 random orders (no drift) | 6% skipped, 62% of lines read | 19% skipped, **45%** read (worst tenth 20%) |

The fixed threshold fails both ways: it under-reads when the code gets harder and over-reads when its first PRs were
unusually risky. The adaptive one spends the stated error budget in both cases.

Assumptions, stated in the product: each outcome is reported before the next PR is triaged; the no-model skips
(proven formatting, docs, lock files) hold no functional bug; and bugs in skipped code are eventually found as often as
bugs in reviewed code. The bound covers bugs that surface, not bugs nobody reports. If skipped-code bugs are found less
often (a fraction q as often), an observed 20% corresponds to a higher true share:

| q (how often skipped-code bugs are found, relative) | 1 | 0.7 | 0.5 | 0.3 |
| --- | --- | --- | --- | --- |
| True share of bugs in skipped code at an observed 20% | 20% | 26% | 33% | 45% |

So the target is a knob: a team that finds skipped-code bugs late should set it lower.

## Related work

PR Lens does not introduce a new statistical method. The offline threshold uses Clopper-Pearson bounds, and the online
one is adaptive conformal inference (Gibbs & Candès, NeurIPS 2021), in the family of conformal risk control
(Angelopoulos et al.) and Learn then Test. The closest software-engineering work is just-in-time conformal defect
prediction (Shahini, Metzger & Pohl, MSR 2024), which decides whether to trust a classifier's verdict on a whole change.
Meta's Diff Risk Score and RADAR score whole diffs and gate auto-landing on risk percentiles. AI reviewers (CodeRabbit,
Copilot review, Greptile, Graphite) add comments and risk levels. What PR Lens adds is the inverted product question,
which regions a human may skip, answered with a stated miss rate that tightens when a bug surfaces in skipped code.

## How it works

1. **Evaluation PRs from real bugs.** `prlens mine` finds recent fix commits that come with a test; `prlens validate`
   keeps those whose tests fail before the fix and pass after; `prlens trace` blames the lines each fix changed and turns
   the commit that wrote them into a PR with the bug's location labelled.
2. **Regions and rules.** Each PR's diff is split into hunks and regions. Skips that need no model and must-review rules
   are applied first.
3. **Score.** Muse Spark Open (on Baseten) rates each remaining region's chance of hiding a functional bug and says why
   (`prlens score`, about $0.004 a region).
4. **Combine and calibrate.** `prlens fit` combines the model's score with simple code signals (logic density, test file,
   size) in a logistic regression fitted without each PR's own repository, and picks the skip threshold whose 90% upper
   bound on the miss rate (Clopper-Pearson) stays within 20%.
5. **Explain.** `prlens explain` asks the Muse Spark Model API for one sentence per review item on what to check there
   (it never changes what is read or skipped).
6. **Review like GitHub.** `prlens export` publishes the set to the dashboard; `prlens triage-pr <link>` does all of this
   for a live GitHub pull request.

## Quickstart

```bash
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env            # BASETEN_API_KEY for Spark Open; META_API_KEY for the Meta API models

prlens models                   # which models are ready (calls none)
prlens triage-pr https://github.com/owner/repo/pull/123 --plan-only   # fetch the diff, show calls and cost
prlens triage-pr https://github.com/owner/repo/pull/123               # asks before calling the model
pytest
```

The dashboard (`web/`, see `web/README.md`) shows triaged PRs the way GitHub does: a Conversation tab with PR Lens's
summary, Files changed with inline comments, skipped code collapsed in place and a review queue, and Checks. It also has
Evaluation, Agent study, Triage a PR, and Pipeline (every `prlens` step, with cost shown before paid ones).

## The pipeline

| Step | What it does | Cost |
| --- | --- | --- |
| `prlens mine` | Recent bug-fix commits with tests | free (git only) |
| `prlens validate` | Keep bugs whose tests fail before the fix and pass after | free, slow |
| `prlens trace` | Trace each fix to the commit that introduced the bug | free |
| `prlens baseline` | No-model skips and simple rankings against the reading gate | free |
| `prlens score` | Model risk score for every region (resumable, rate limits retried) | paid, asks first |
| `prlens score-eval` | How well the scores rank the real bugs | free |
| `prlens fit` | Combiner weights and skip threshold, with a held-out check | free |
| `prlens adapt` | Replay fixed vs adaptive threshold (date order, drift, random orders) | free |
| `prlens ablation` | Random / code features / model alone / combined, calibration, repository bootstrap | free |
| `prlens export` | Publish `data/triage_eval*.json` to the dashboard | free |
| `prlens triage-pr` | Triage a live GitHub PR (`--explain` adds the notes) | paid, asks first |
| `prlens explain` | One-sentence notes on review items (Muse Spark Model API) | paid, asks first |
| `prlens agent-study` | Muse Code re-implements evaluation commits; validate with the fix's tests; triage | paid, asks first |
| `prlens suggest` | Muse Code suggests a fix for the flagged regions (and a no-flags control); the later fix's tests judge it | paid, asks first |

## Repository layout

| Path | What is there |
| --- | --- |
| `src/prlens/` | The package: diff parsing and rules (`hunks.py`), tracing, scoring, fitting, export, live triage, model registry |
| `data/bug_fixes.jsonl` | Confirmed bug fixes (repo, fix commit, changed lines) |
| `data/triage/` | Traced PRs, region scores, fitted combiner |
| `data/triage_eval.json` | The evaluation set as the dashboard shows it |
| `data/repos/` | Repository lists for mining |
| `web/` | Dashboard: Next.js frontend, Fastify backend, Postgres via Drizzle |
| `infra/` | Helpers for running Muse Glimmer on Fireworks or Modal |
| `tests/` | Unit tests |

## Meta models used

| Model | Role | Access |
| --- | --- | --- |
| Muse Spark Open | Scores every region and writes the reason, as structured JSON (all results above) | Open weights on Baseten |
| Muse Spark | Writes the one-line note on what to check (demo and agent-study PRs) | Meta Model API |
| Muse Code (agent) | Writes the agent-study pull requests, and the suggested fixes in the fix-loop experiment | Muse Code CLI |
| Muse Wonder | Wired as an alternative scorer; not evaluated | Meta Model API |
| Muse Glimmer | Wired as an alternative scorer; not evaluated | Open weights (MLX locally, or Fireworks) |

## Built during the hackathon (Oct 26 – Nov 4, 2026)

All code in this repository was written during the hackathon, starting October 26, 2026. The commit history is the
record. The project started as BugCensus, an estimate of how many bugs AI review missed; on October 28 it pivoted to PR
Lens. The git tag `pre-pivot` keeps the earlier work (decoys, realism checks, calibration).

## License

MIT
