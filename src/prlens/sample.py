"""Pick which mined candidates to validate: the newest few per repository, minus any already judged.

    prlens sample --candidates data/candidates_python_v2.jsonl --per-repo 15 --out data/candidates_python_v2_sample.jsonl

"Already judged" means the commit appears in any data/bugs*.jsonl (confirmed, rejected or skipped) or in an earlier
sample, so a re-mine of a known repository only adds new commits.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

from .bugdata import ROOT


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--per-repo", type=int, default=15)
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    seen = set()
    for f in list((ROOT / "data").glob("bugs*.jsonl")) + list((ROOT / "data").glob("candidates_*sample*.jsonl")):
        if Path(f).resolve() == Path(args.out).resolve():
            continue
        for l in open(f):
            if l.strip():
                seen.add(json.loads(l)["sha"])
    for l in open(ROOT / "data" / "bug_fixes.jsonl"):
        seen.add(json.loads(l)["sha"])
    by_repo = defaultdict(list)
    for l in open(args.candidates):
        c = json.loads(l)
        if c["sha"] not in seen:
            by_repo[c["name"]].append(c)
    out = []
    for name, cs in sorted(by_repo.items()):
        out += sorted(cs, key=lambda c: c["date"], reverse=True)[: args.per_repo]
    Path(args.out).write_text("".join(json.dumps(c) + "\n" for c in out))
    print(f"{len(out)} new candidates from {len(by_repo)} repositories -> {args.out}")
