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


def _panel(dry_run: bool, panel: str | None = None):
    from .review import FakeReviewer, LLMReviewer

    if dry_run:
        return [FakeReviewer("fake-a", 0.7, 1), FakeReviewer("fake-b", 0.5, 2)]
    reg = registry()
    names = [n.strip() for n in panel.split(",") if n.strip()] if panel else panel_names()
    unknown = [n for n in names if n not in reg]
    if unknown:
        sys.exit(f"Unknown panel members: {unknown}. Known: {list(reg)}")
    return [LLMReviewer(reg[n]) for n in names]


def cmd_review(args):
    from .pipeline import format_report, run_census

    import os

    rep = run_census(args.file, _panel(args.dry_run, args.panel), _ranges(args.lines), n_copies=args.copies,
                     per_copy=args.per_copy, seed=args.seed)
    if os.getenv("BUGCENSUS_JOB_ID"):   # set when the dashboard launched this run
        rep["job_id"] = os.getenv("BUGCENSUS_JOB_ID")
    print(json.dumps(rep, indent=2) if args.json else format_report(rep))
    _push(rep, "census")


def _push(payload: dict, kind: str) -> None:
    """Send a finished run to the dashboard backend if BUGCENSUS_API_URL is set. Never fails the run:
    the JSON file in runs/ is the record, and `npm run import` can load it later."""
    import os
    import urllib.request

    base = os.getenv("BUGCENSUS_API_URL", "").rstrip("/")
    if not base:
        return
    req = urllib.request.Request(f"{base}/api/import/{kind}", data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json", "X-BugCensus-Client": "1"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read() or b"{}")
        print(f"Dashboard: saved run {body.get('id', '?')}", file=sys.stderr)
    except Exception as exc:  # dashboard down: keep going
        print(f"Dashboard: not saved ({exc}); import later with `npm run import` in web/backend",
              file=sys.stderr)


def cmd_models(args):
    if args.list:
        return _list_models(args.json)
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


def _list_models(as_json: bool) -> None:
    """Which reviewers exist and whether each is ready to use. No model is called: hosted models are
    'ready' when their key is set; a local server is checked with a GET on /models (1 s timeout)."""
    import urllib.request

    from .config import describe

    out = []
    for name, spec in registry().items():
        info = {**describe(spec), "key_env": spec.api_key_env, "local": spec.local}
        if spec.local:
            try:
                urllib.request.urlopen(spec.base_url.rstrip("/") + "/models", timeout=1).close()
                info["ready"], info["why"] = True, "local server is up"
            except Exception:
                info["ready"], info["why"] = False, f"local server not reachable at {spec.base_url}"
        elif not spec.api_key:
            info["ready"], info["why"] = False, f"{spec.api_key_env} is not set"
        elif spec.provider == "fireworks" and "/deployments/" not in spec.model_id:
            info["ready"], info["why"] = False, "set FIREWORKS_GLIMMER_MODEL to your deployment (scripts/fireworks_glimmer.sh)"
        else:
            info["ready"], info["why"] = True, "key set"
        out.append(info)
    if as_json:
        print(json.dumps(out))
    else:
        for m in out:
            print(f"{m['reviewer']:11s} {m['provider']:10s} {m['model_id']:45s} {'READY' if m['ready'] else 'not ready'}: {m['why']}")


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
            s.add_argument("--panel", help="comma list of reviewers, e.g. spark,glimmer (default: BUGCENSUS_PANEL)")
    m = sub.add_parser("models")
    m.add_argument("--efforts", help="comma list to probe, e.g. minimal,low,medium,high,xhigh")
    m.add_argument("--list", action="store_true", help="list reviewers and whether each is ready (no API calls)")
    m.add_argument("--json", action="store_true", help="with --list: print JSON")
    m.set_defaults(func=cmd_models)
    args = p.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
