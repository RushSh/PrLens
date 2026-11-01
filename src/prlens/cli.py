"""prlens <step> [options]: one entry point for the whole pipeline.

    mine        find recent bug-fix commits that come with a test          (prlens.mine)
    validate    keep those whose tests fail before the fix and pass after  (prlens.validate)
    index       add confirmed bugs to data/bug_fixes.jsonl                 (prlens.index)
    trace       trace each fix to the commit that introduced the bug      (prlens.trace)
    baseline    no-model rules and simple rankings on the traced PRs       (prlens.trace)
    score       score every region with a model (paid; asks first)         (prlens.score)
    score-eval  how well the scores rank the real bugs                     (prlens.score)
    fit         fit the combiner and the skip threshold                    (prlens.fit)
    adapt       replay the evaluation PRs: fixed vs adaptive skip threshold (prlens.adaptive)
    export      write data/triage_eval.json for the dashboard              (prlens.export)
    triage-pr   triage a live GitHub pull request (paid; asks first)       (prlens.live)
    agent-study the Muse Code agent re-implements evaluation PRs            (prlens.agentstudy)
    sample      pick new candidates to validate (newest per repo, unjudged)  (prlens.sample)
    ablation    does the model earn its place? baselines, reliability, bootstrap (prlens.ablation)
    models      the configured models and whether each is ready            (prlens.models)

`prlens <step> -h` shows the step's own options.
"""
from __future__ import annotations

import importlib
import sys

STEPS: dict[str, tuple[str, list[str]]] = {
    "mine": ("mine", []),
    "validate": ("validate", []),
    "index": ("index", []),
    "trace": ("trace", ["trace"]),
    "baseline": ("trace", ["baseline"]),
    "score": ("score", ["run"]),
    "score-eval": ("score", ["eval"]),
    "fit": ("fit", []),
    "adapt": ("adaptive", []),
    "export": ("export", []),
    "triage-pr": ("live", []),
    "models": ("models", []),
    "agent-study": ("agentstudy", []),
    "sample": ("sample", []),
    "ablation": ("ablation", []),
    "explain": ("explain", []),
    "suggest": ("suggest", []),
}


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if not argv or argv[0] in ("-h", "--help") or argv[0] not in STEPS:
        print(__doc__)
        sys.exit(0 if argv and argv[0] in ("-h", "--help") else 2)
    module, prefix = STEPS[argv[0]]
    importlib.import_module(f"prlens.{module}").main(prefix + argv[1:])


if __name__ == "__main__":
    main()
