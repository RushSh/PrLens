# BugCensus

**We plant decoy bugs to measure what your AI code reviewers missed.**

AI now writes much of our code, and AI reviewers check it. Every review tool tells you what it *found*. None tells you what it *missed*. BugCensus estimates how many real bugs are still hiding in a change after review, with an interval, and tells you where to look.

Built with Meta's Muse models for the [Meta Global AI Developer Hackathon](https://cerebralvalley.ai/e/meta-ai-developer-hackathon) (Indie Developer track, problem statement: *Push the Frontier*).

## How it works

1. **Plant decoys.** BugCensus makes throwaway copies of the changed code and plants a few realistic, behavior-changing bugs in each copy (a shifted boundary, a dropped guard clause, a swapped operator, and later decoys generated from Muse open-weight models' own near-mistakes).
2. **Review everything the same way.** A panel of reviewers (Muse Spark, Muse Wonder, Muse Glimmer, Muse Spark Open, a static analyzer) reviews the original and each copy in separate, fresh calls with identical prompts. No reviewer knows decoys exist.
3. **Count.** The share of decoys that *every* reviewer missed measures how blind the panel is on this code, including blind spots the models share.
4. **Estimate.** A small Bayesian model turns that blind rate, the verified bugs found, and the repository's history into the expected number of bugs still hidden, an interval, and a status: **CLEAR**, **LOOK HERE** or **NEEDS REVIEW**.

Your repository is never modified: decoys exist only in memory or in temporary copies that are deleted after the run.

## Status

Day 1 of the hackathon. Working today:

- decoy seeder (classic families) with behavior checks that reject decoys that don't change behavior;
- reviewer client for any OpenAI-compatible endpoint (Meta Model API, Baseten), with token-usage logging;
- the census estimator (Gamma-Poisson bug rate, Beta blind rate, NegBin reweighting), checked against brute-force Monte Carlo in the tests;
- an end-to-end `bugcensus review` on one file, plus an offline `--dry-run`;
- scripts to mine and validate recent real bug fixes for the realism test and calibration plot.

Not yet built (see the roadmap): the bug verifier, model-native decoys, the codebase sweep agent, and the GitHub integration. Until the verifier exists, "bugs found" counts unverified findings and the output says so.

## Quickstart

```bash
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env          # add META_API_KEY; check the model IDs against the Meta model list

bugcensus decoys examples/billing.py            # preview decoys, no API calls
bugcensus review examples/billing.py --dry-run  # full pipeline with fake reviewers, no API calls
bugcensus models --efforts low,medium,high      # smoke-test each model and log token usage
bugcensus review examples/billing.py            # real census with the panel in BUGCENSUS_PANEL
pytest
```

`examples/billing.py` contains one known real bug (`average_order_value` subtracts 1), so you can check whether the panel finds it.

### Mining real bugs for the realism test

```bash
python scripts/mine_bugs.py --repos scripts/repos.txt --since 2026-06-01 --out data/candidates.jsonl
python scripts/validate_bugs.py --candidates data/candidates.jsonl --out data/bugs.jsonl
```

A candidate is kept only if its fix commit adds or changes a test that fails before the fix and passes after it.

## Repository layout

| Path | What it is |
| --- | --- |
| `src/bugcensus/seed.py` | Decoy candidates, behavior checks, seeded copies |
| `src/bugcensus/review.py` | Reviewer prompt, model client, findings parser |
| `src/bugcensus/match.py` | Decoy matching and finding deduplication |
| `src/bugcensus/estimate.py` | The census math |
| `src/bugcensus/pipeline.py` | One census run on one file |
| `src/bugcensus/cli.py` | `bugcensus` command |
| `scripts/` | Real-bug mining and validation |
| `infra/modal_glimmer.py` | Download Muse Glimmer weights to a Modal volume |
| `tests/` | Unit tests, including a Monte Carlo check of the estimator |

## Meta models used

| Model | Role | Access |
| --- | --- | --- |
| Muse Spark | Reviewer, test writer for the verifier | Meta Model API |
| Muse Wonder | Strong reviewer for escalations | Meta Model API |
| Muse Glimmer | Local reviewer; model-native decoys from token probabilities | Open weights on Modal |
| Muse Spark Open | Reviewer; model-native decoys | Open weights on Baseten |
| Muse Code | Writes and fixes code in the demo loop | Muse Code |

## Built during the hackathon (Oct 26 – Nov 4, 2026)

All code in this repository was written during the hackathon, starting October 26, 2026. The commit history is the record.

Before the event, I wrote a design proposal and ran statistical simulations to choose the approach (October 22–25). That was design and research only; none of it is copied into this repository as product code.

## Roadmap

| Day | Plan |
| --- | --- |
| Mon Oct 26 | Repository, reviewer client, decoy seeder, estimator, tests, mining scripts |
| Tue Oct 27 | Realism test: about 200 real bugs vs decoys |
| Wed Oct 28 | Model-native decoys (Glimmer, Spark Open), new decoy families, seed reweighting |
| Thu Oct 29 | Verifier (reproducing tests in a sandbox), strict decoy matching |
| Fri Oct 30 | Calibration plot on real bugs |
| Sat–Sun | Codebase sweep agent; runs on real open-source projects |
| Mon Nov 2 | Muse Code loop, reuse check, GitHub check output |
| Tue–Wed | Demo video, write-up, submission |

## License

MIT
