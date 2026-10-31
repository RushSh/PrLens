# PR Lens

**Which parts of a pull request need a human reviewer, and which are safe to skip, with a measured miss rate.**

AI agents now write pull requests faster than people can read them, and AI reviewers comment on what they find. None of
them tells the human what is safe *not* to read, and an AI reviewer's silence is not a guarantee. PR Lens splits every PR
into regions of up to about 25 changed lines and puts each in one of two places:

- **Needs a human**: a risk score, a priority (P0-P2) and a one-sentence note on what to check, shown inline as a
  review comment on the exact lines, plus rules that always ask for a human (migrations, security-sensitive code,
  changed or removed public signatures, removed error handling, text addressed to an AI reviewer).
- **Skipped**: collapsed in place with its reason: docs, formatting-only changes (proven: the syntax tree is unchanged),
  lock files, generated code, config, test data, or a combined risk score under a threshold calibrated on real bugs.

The threshold comes with a promise: if a PR has a functional bug, it lands in the skipped part at most 20% of the time,
at 90% confidence, measured on PRs PR Lens never saw while it was fitted.

Built with Meta's Muse models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
(Indie Developer track).

## Results so far (Oct 30 2026)

183 real commits from 27 open-source libraries in three languages, each of which introduced a bug that a later commit
fixed (the fix's own tests fail before it and pass after). PR Lens triaged each without knowing where the bug was. Each
language is fitted and calibrated on its own; every number is out of fold (a repository is never scored by a fit that
saw it).

| | Python | TypeScript | C# |
| --- | --- | --- | --- |
| PRs (repositories) | 75 (10) | 72 (9) | 36 (8) |
| Bug kept in the review list | 65 of 75 | 63 of 72 | 33 of 36 |
| Lines left to read | 49% | 43% | 47% |
| Threshold chosen without the PR's repository | 9 skipped, 50% read | 10 skipped, 44% read | 3 skipped, 47% read |
| Ranking quality (AUC), combined / model alone | 0.82 / 0.74 | 0.82 / 0.73 | 0.69 / 0.72 |

**Does the model earn its place?** At the same 20% miss target, held out by repository, the share of lines left to read:

| Ranking | Python | TypeScript |
| --- | --- | --- |
| Random skipping | 83% | 72% |
| Logic density alone | 70% | 71% |
| Code features, no model | 52% | 44% |
| Spark Open alone | 66% | 53% |
| **PR Lens (combined)** | **50%** | **44%** |

The honest reading: most of the saving comes from cheap code features; Spark Open saves 0–2 more points of reading on
top, and on its own it ranks worse than they do. The scores are calibrated (expected calibration error 1.6% Python, 1.7%
TypeScript), and resampling whole repositories puts the 90th-percentile miss rate (19.0% / 17.6%) inside the
Clopper-Pearson bound (19.8% / 19.0%). C# has too few PRs for its combiner to beat code features alone; it is shown with
that caveat.

**On agent-written PRs.** The Muse Code agent (muse-spark-1.3-contributor) re-implemented 25 evaluation commits from a
snapshot of each commit's parent and its message. The fix's own tests could judge 11 of its PRs; 10 held a confirmed bug,
and PR Lens kept 8 of those 10 in the review list while leaving 27% of lines to read. Both misses are TypeScript regions
scored just under the threshold. A case study, not a calibrated rate (Agent study tab).

Caveats: most evaluation commits were written by people and are small; 183 PRs is a modest set. The Evaluation tab shows
the full curves, per-repository results, the ablation and the calibration chart.

## A promise that survives drift

A threshold calibrated once breaks when new PRs differ from old ones. Replayed in date order, the fixed Python
threshold skips 43% of bugs against a promised 20%. PR Lens instead moves each repository's threshold whenever a bug
surfaces: a bug in skipped code tightens it, a bug in code it sent to review loosens it, and a PR with no bug leaves it
alone (each PR counts once):

    theta_{t+1} = theta_t - eta * (err_t - alpha)        (threshold = sigmoid(theta); adaptive conformal inference)

For every sequence of PRs, drifting or even adversarial, the share of the n surfaced bugs that sat in skipped code is at
most `alpha + (theta_1 - logit(floor) + eta*(1 - alpha)) / (eta*n)`. That is 32% after 60 bugs and 23% after 200, falling
toward 20% (proof in `src/prlens/adaptive.py`; the tests check it against an adversary).

| Replay of the Python evaluation PRs (60 after a 15-PR warm-up) | Fixed threshold | Adaptive threshold |
| --- | --- | --- |
| Date order | 43% of bugs skipped | 22% skipped, under the proven ceiling of 32% |
| Hardest repositories last | 43% | 23% |
| 200 random orders (no drift) | 6% skipped, 57% of lines read | 17% skipped, **48%** read (worst tenth 20%) |

Assumptions, stated in the product: each outcome is reported before the next PR is triaged, and the no-model skips
(proven formatting, docs, lock files) hold no functional bug.

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
| Muse Spark Open | Scores every region and writes the reason (all results above) | Open weights on Baseten |
| Muse Spark | Writes the one-line note on each review item | Meta Model API |
| Muse Code (agent) | Writes the agent-study pull requests | Muse Code CLI |
| Muse Wonder | Alternative scorer for hard cases | Meta Model API |
| Muse Glimmer | Alternative scorer, free when run locally | Open weights (MLX locally, or Fireworks) |

## Built during the hackathon (Oct 26 – Nov 4, 2026)

All code in this repository was written during the hackathon, starting October 26, 2026. The commit history is the
record. The project started as BugCensus, an estimate of how many bugs AI review missed; on October 28 it pivoted to PR
Lens. The git tag `pre-pivot` keeps the earlier work (decoys, realism checks, calibration).

## License

MIT
