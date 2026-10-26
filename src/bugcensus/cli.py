"""bugcensus command line.

  bugcensus decoys FILE [--lines 10-40]        preview the decoys that would be planted (no API calls)
  bugcensus review FILE [--lines 10-40] [--dry-run]   full census on one file
  bugcensus models                              smoke-test each configured model and log token usage
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from .config import panel_names, registry


def _ranges(spec: str | None):
    if not spec:
        return None
    out = []
    for part in spec.split(","):
        a, _, b = part.partition("-")
        out.append((int(a), int(b or a)))
    return out


def cmd_decoys(args):
    from pathlib import Path
    from .seed import make_copies, valid_decoys

    src = Path(args.file).read_text()
    decoys = valid_decoys(src, _ranges(args.lines))
    print(f"{len(decoys)} behavior-changing decoy candidates")
    for d in decoys:
        print("  " + d.describe())
    for c in make_copies(src, decoys, n_copies=args.copies, per_copy=args.per_copy):
        print(f"\n{c.name}: {len(c.decoys)} decoys")
        for d in c.decoys:
            print(f"  line {d.final_line}: {d.describe()}")


def _panel(dry_run: bool):
    from .review import FakeReviewer, LLMReviewer

    if dry_run:
        return [FakeReviewer("fake-a", 0.7, 1), FakeReviewer("fake-b", 0.5, 2)]
    reg = registry()
    names = panel_names()
    unknown = [n for n in names if n not in reg]
    if unknown:
        sys.exit(f"Unknown panel members: {unknown}. Known: {list(reg)}")
    return [LLMReviewer(reg[n]) for n in names]


def cmd_review(args):
    from .pipeline import format_report, run_census

    rep = run_census(args.file, _panel(args.dry_run), _ranges(args.lines), n_copies=args.copies,
                     per_copy=args.per_copy, seed=args.seed)
    print(json.dumps(rep, indent=2) if args.json else format_report(rep))


def cmd_models(args):
    from openai import OpenAI

    for name, spec in registry().items():
        if not spec.api_key:
            print(f"{name:11s} SKIP ({spec.api_key_env} not set)")
            continue
        client = OpenAI(api_key=spec.api_key, base_url=spec.base_url)
        for effort in (args.efforts.split(",") if args.efforts else [None]):
            kw = {"reasoning_effort": effort} if effort else {}
            t0 = time.time()
            try:
                r = client.chat.completions.create(model=spec.model_id, messages=[
                    {"role": "user", "content": "Reply with the single word: ok"}], **kw)
                u = r.usage
                print(f"{name:11s} {spec.model_id:35s} effort={effort or '-':8s} OK "
                      f"{time.time()-t0:5.1f}s in={u.prompt_tokens} out={u.completion_tokens} "
                      f"reply={r.choices[0].message.content!r:.30}")
            except Exception as exc:
                print(f"{name:11s} {spec.model_id:35s} effort={effort or '-':8s} FAIL {type(exc).__name__}: {str(exc)[:120]}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="bugcensus")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name, fn in (("decoys", cmd_decoys), ("review", cmd_review)):
        s = sub.add_parser(name)
        s.add_argument("file")
        s.add_argument("--lines", help="changed line ranges, e.g. 10-40,55-60")
        s.add_argument("--copies", type=int, default=2)
        s.add_argument("--per-copy", type=int, default=5)
        s.add_argument("--seed", type=int, default=0)
        s.set_defaults(func=fn)
        if name == "review":
            s.add_argument("--dry-run", action="store_true", help="offline fake reviewers, no API calls")
            s.add_argument("--json", action="store_true")
    m = sub.add_parser("models")
    m.add_argument("--efforts", help="comma list to probe, e.g. minimal,low,medium,high,xhigh")
    m.set_defaults(func=cmd_models)
    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
