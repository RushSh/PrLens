# PR Lens

**Which parts of a pull request need a human reviewer, and which are safe to skip, with a measured miss rate.**

AI agents now write pull requests faster than people can read them, and AI reviewers comment on what they find. None of
them tells the human what is safe *not* to read, and an AI reviewer's silence is not a guarantee. PR Lens splits every PR
into regions of up to about 25 changed lines and puts each in one of two places:

- **Needs a human**: a risk score, a priority (P0-P2) and a one-sentence reason a reviewer can check, shown inline as a
  review comment on the exact lines, plus rules that always ask for a human (migrations, security-sensitive code,
  changed or removed public signatures).
- **Skipped**: collapsed in place with its reason: docs, formatting-only changes (proven: the syntax tree is unchanged),
  lock files, generated code, config, test data, or a combined bug chance under a threshold calibrated on real bugs.

The threshold comes with a promise: if a PR has a functional bug, it lands in the skipped part at most 20% of the time,
at 90% confidence, measured on PRs PR Lens never saw while it was fitted.

Built with Meta's Muse models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon)
(Indie Developer track).

## Results so far (Python, Oct 28 2026)

75 real commits from 10 open-source Python libraries, each of which introduced a bug that a later commit fixed (the fix's
own tests fail before it and pass after). PR Lens triaged each without knowing where the bug was.

| | |
| --- | --- |
| Bug kept in the review list | 65 of 75 PRs |
| Lines left to read | 47% |
| Threshold chosen without the PR's repository | 10 of 75 bugs skipped, 48% of lines read |
| Bug found in the riskiest third of lines | 61% of PRs (random reading: about 36%) |
| Ranking quality (AUC) | 0.83 combined, 0.74 for the model alone |

Caveats: Python only so far (TypeScript and C# evaluation sets are in progress); 75 PRs is a small set; most of these
commits were written by people. The Evaluation tab of the dashboard shows the full curve and per-repository results.

## A promise that survives drift

A threshold calibrated once breaks when new PRs differ from old ones. Replayed in date order, the fixed threshold
skips 33% of bugs against a promised 20%. PR Lens instead moves each repository's threshold after every reviewed PR:
a reviewer marks "Bug here" on skipped code (or finishes with "nothing missed"), and

    theta_{t+1} = theta_t - eta * (err_t - alpha)        (threshold = sigmoid(theta); adaptive conformal inference)

For every sequence of PRs, drifting or even adversarial, the miss rate after n PRs is at most
`alpha + (theta_1 - logit(floor) + eta*(1 - alpha)) / (eta*n)`. That is 31% after 60 PRs and 23% after 200, falling
toward 20% (proof in `src/prlens/adaptive.py`; the tests check it against an adversary).

| Replay of the 75 evaluation PRs | Fixed threshold | Adaptive threshold |
| --- | --- | --- |
| Date order | 33% of bugs skipped | 22% skipped, under the proven ceiling of 31% |
| Hardest repositories last | 33% | 23% |
| 200 random orders (no drift) | 7% skipped, 57% of lines read | 17% skipped, **46%** read (worst tenth 20%) |

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
5. **Review like GitHub.** `prlens export` publishes the set to the dashboard; `prlens triage-pr <link>` does all of this
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
Evaluation, Triage a PR, and Pipeline (every `prlens` step, with cost shown before paid ones).

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
| `prlens export` | Publish `data/triage_eval.json` to the dashboard | free |
| `prlens triage-pr` | Triage a live GitHub PR | paid, asks first |

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
| Muse Spark | Alternative scorer | Meta Model API |
| Muse Wonder | Alternative scorer for hard cases | Meta Model API |
| Muse Glimmer | Alternative scorer, free when run locally | Open weights (MLX locally, or Fireworks) |

## Built during the hackathon (Oct 26 – Nov 4, 2026)

All code in this repository was written during the hackathon, starting October 26, 2026. The commit history is the
record. The project started as BugCensus, an estimate of how many bugs AI review missed; on October 28 it pivoted to PR
Lens. The git tag `pre-pivot` keeps the earlier work (decoys, realism checks, calibration).

## License

MIT
