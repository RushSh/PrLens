"""Judge findings against known bugs for a calibration experiment or a realism check (see bugcensus/judge.py).

  python scripts/judge.py --tag fw1 [--model spark] [--plan-only] [--yes]
  python scripts/judge.py --realism-reviews data/realism_reviews_v2.jsonl --realism-units data/realism_units_x.jsonl

One call per (version, reviewer, bug) that has findings nearby, plus placebo calls (a different bug's diff) on
about 15% of them. Verdicts are cached in data/judge/; analyze with --matcher judge to use them.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from bugcensus import judge as J  # noqa: E402
from bugcensus.bugdata import load_index, unified  # noqa: E402
from bugcensus.llm import chat, confirm, plan_line, spec  # noqa: E402


def calibration_targets(tag: str, units_file: Path | None = None) -> tuple[str, list[dict]]:
    """Every (version, reviewer, bug) in a calibration experiment: real bugs in originals, decoys in copies."""
    exp = ROOT / "data" / "calibration" / tag
    meta = json.loads((exp / "meta.json").read_text()) if (exp / "meta.json").exists() else {}
    units_path = units_file or ROOT / meta.get("units", "data/calibration_units.jsonl")
    units = {u["unit_id"]: u for u in map(json.loads, Path(units_path).read_text().splitlines()) if u}
    copies = {c["unit_id"]: c for c in map(json.loads, (exp / "copies.jsonl").read_text().splitlines()) if c}
    index = load_index()
    reviews = [json.loads(l) for l in (exp / "reviews.jsonl").read_text().splitlines() if l.strip()]
    by = {(r["unit_id"], r["version"], r["reviewer"]): r for r in reviews if r["error"] is None}
    out = []
    for (uid, version, reviewer), r in by.items():
        u = units.get(uid)
        if not u:
            continue
        if version == "original":
            for b in u["blocks"]:
                if b["form"] != "buggy" or b["bug_id"] not in index:
                    continue
                fixed_block = index[b["bug_id"]]["fixed"]
                out.append({"version": f"{uid}|original", "reviewer": reviewer, "target": b["bug_id"],
                            "lines": b["real_lines"], "reviewed": u["original"],
                            "diff": unified(b["text"], fixed_block), "findings": r["findings"]})
        else:
            c = next((c for c in copies.get(uid, {}).get("copies", []) if c["name"] == version), None)
            if not c:
                continue
            for d in c["decoys"]:
                out.append({"version": f"{uid}|{version}", "reviewer": reviewer, "target": f"decoy@{d['line']}",
                            "lines": [d["line"]], "reviewed": c["text"],
                            "diff": J.hunk_near(c["text"], u["original"], d["line"]), "findings": r["findings"]})
    return f"calibration:{tag}", out


def realism_targets(reviews_file: Path, units_file: Path) -> tuple[str, list[dict]]:
    """Every (unit, reviewer) in a realism check: the unit's one bug (real or decoy)."""
    units = {u["unit_id"]: u for u in map(json.loads, units_file.read_text().splitlines()) if u}
    index = load_index()
    out = []
    for line in reviews_file.read_text().splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        u = units.get(r["unit_id"])
        if r.get("error") is not None or not u or u["bug_id"] not in index:
            continue
        fixed = index[u["bug_id"]]["fixed"]
        out.append({"version": u["unit_id"], "reviewer": r["reviewer"], "target": u["unit_id"],
                    "lines": u["bug_lines"], "reviewed": u["snippet"], "diff": unified(u["snippet"], fixed),
                    "findings": r["findings"]})
    return f"realism:{reviews_file.name}", out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tag", help="calibration experiment")
    ap.add_argument("--realism-reviews")
    ap.add_argument("--realism-units", help="units file of the realism check (default: guessed from the reviews' unit ids)")
    ap.add_argument("--model", default="spark")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--plan-only", action="store_true")
    ap.add_argument("--yes", action="store_true")
    args = ap.parse_args()

    if args.tag:
        source, targets = calibration_targets(args.tag)
    elif args.realism_reviews:
        units = Path(args.realism_units) if args.realism_units else _guess_units(Path(args.realism_reviews))
        source, targets = realism_targets(Path(args.realism_reviews), units)
    else:
        sys.exit("give --tag or --realism-reviews")

    cache_file = J.cache_path(ROOT, source)
    cache = J.load_cache(cache_file)
    rng = random.Random(0)
    calls = []
    for t in targets:
        cands = J.near(t["findings"], t["lines"])
        if not cands:
            continue
        k = J.key(source, t["version"], t["reviewer"], t["target"])
        if k not in cache:
            calls.append((k, t, cands, None))
        if J.is_placebo(k):
            pk = J.key(source, t["version"], t["reviewer"], t["target"], placebo=True)
            if pk not in cache:
                other = rng.choice([o for o in targets if o["target"] != t["target"]] or [t])
                calls.append((pk, t, cands, other["diff"]))
    s = spec(args.model)
    line, _ = plan_line(s, len(calls), out_tokens_per_call=600, scale=0.35)   # short prompts and replies
    confirm(f"judge {source}: {len(targets)} bug/reviewer pairs, {len(calls)} calls still to make "
            f"({sum(1 for c in calls if c[3] is not None)} placebo), {len(cache)} cached\n{line}",
            args.yes, args.plan_only)

    cache_file.parent.mkdir(parents=True, exist_ok=True)

    def one(c):
        k, t, cands, wrong_diff = c
        r = chat(s, J.render(t, cands, wrong_diff), purpose=f"judge|{source}")
        data = r.json() if not r.error else None
        if data is None:
            return {"key": k, "error": r.error or "no JSON"}
        matches = [int(i) for i in data.get("matches", []) if str(i).lstrip("-").isdigit() and 0 <= int(i) < len(cands)]
        return {"key": k, "placebo": wrong_diff is not None, "matches": matches, "n_candidates": len(cands),
                "reason": str(data.get("reason", ""))[:200], "model": s.model_id, "version": t["version"],
                "reviewer": t["reviewer"], "target": t["target"]}

    errors, t0 = 0, time.time()
    with cache_file.open("a") as fh, ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n, fut in enumerate(as_completed([pool.submit(one, c) for c in calls]), 1):
            row = fut.result()
            if "error" in row:
                errors += 1
            else:
                fh.write(json.dumps(row) + "\n")
                fh.flush()
            if n % 20 == 0 or n == len(calls):
                print(f"  {n}/{len(calls)} ({errors} errors, retried on the next run) {time.time() - t0:.0f}s", flush=True)
    cache = J.load_cache(cache_file)
    real = [v for v in cache.values() if not v.get("placebo")]
    plac = [v for v in cache.values() if v.get("placebo")]
    print(f"judge said 'describes the bug' for {sum(bool(v['matches']) for v in real)} of {len(real)} pairs with nearby findings")
    if plac:
        print(f"placebo (a different bug's diff): said yes {sum(bool(v['matches']) for v in plac)} of {len(plac)} times "
              f"({sum(bool(v['matches']) for v in plac) / len(plac):.0%}); lower is better")


def _guess_units(reviews: Path) -> Path:
    ids = {json.loads(l)["unit_id"] for l in reviews.read_text().splitlines()[:50] if l.strip()}
    for f in sorted((ROOT / "data").glob("realism_units*.jsonl")):
        have = {json.loads(l)["unit_id"] for l in f.read_text().splitlines() if l.strip()}
        if ids <= have:
            return f
    sys.exit("could not find the units file for these reviews; pass --realism-units")


if __name__ == "__main__":
    main()
