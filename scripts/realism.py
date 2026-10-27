"""Realism check: are planted decoys as hard for AI reviewers to spot as real bugs?

Design (fixed before looking at results):
  - REAL unit: the buggy (pre-fix) version of the function(s) a confirmed bug fix touched.
  - DECOY unit: the FIXED version of the same function(s) with one planted decoy, kept only if
    the fix's own test FAILS on it. Real bugs and decoys therefore live in the same code and are
    caught by the same test (which also guarantees the decoy changes behavior on realistic inputs).
  - Each unit is reviewed by each panel model in a fresh call with the identical prompt.
  - A unit counts as caught by a reviewer if a finding of <= MAX_SPAN lines covers a bug line (+-1).
  - Primary metric: gap delta = logit(decoy detection) - logit(real detection), per reviewer and for
    the panel (caught by any reviewer). Bootstrap 95% CI over bugs. Go if |gap| < 0.5 after reweighting.

Stages:
  python scripts/realism.py prepare --bugs data/bugs.jsonl --repos scripts/repos.txt --work ~/rc --out data/realism_units.jsonl
  python scripts/realism.py review  --units data/realism_units.jsonl --out data/realism_reviews.jsonl
  python scripts/realism.py analyze --units data/realism_units.jsonl --reviews data/realism_reviews.jsonl
"""
from __future__ import annotations

import argparse
import ast
import difflib
import json
import random
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from datetime import datetime, timezone  # noqa: E402
import hashlib  # noqa: E402

from bugcensus.config import describe, registry  # noqa: E402
from bugcensus.review import PROMPT  # noqa: E402

PROMPT_SHA = hashlib.sha256(PROMPT.encode()).hexdigest()[:12]
MAX_SPAN = 6        # findings longer than this don't count as pointing at a bug
TRIES = 14          # decoy candidates tried per bug
KEEP = 2            # decoys kept per bug (different kinds)


def sh(cmd, cwd=None, timeout=600):
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)


# ------------------------------------------------------------------------------------ prepare

def find_func(source: str, name: str, near: int):
    """Return (start, end) lines of the function `name` closest to line `near`."""
    best = None
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name:
            start = min([d.lineno for d in node.decorator_list] + [node.lineno])
            if best is None or abs(start - near) < abs(best[0] - near):
                best = (start, node.end_lineno)
    return best


def snippet(source: str, ranges):
    """Concatenate function ranges; return text and a map from (absolute line) -> snippet line."""
    lines = source.splitlines()
    out, mapping = [], {}
    for k, (a, b) in enumerate(ranges):
        if k:
            out.append("")
        for ln in range(a, b + 1):
            out.append(lines[ln - 1])
            mapping[ln] = len(out)
    return "\n".join(out) + "\n", mapping


def changed_lines(old_text: str, new_text: str):
    """Lines (1-based) in old_text that the fix changed; insertions mark the neighbouring lines."""
    old, new = old_text.splitlines(), new_text.splitlines()
    marks = set()
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new).get_opcodes():
        if tag in ("replace", "delete"):
            marks.update(range(i1 + 1, i2 + 1))
        elif tag == "insert":
            marks.update(x for x in (i1, i1 + 1) if 1 <= x <= len(old))
    return sorted(marks)


def ensure_env(repo_dir: Path, venv: Path, install_cmd: str) -> bool:
    if (venv / "bin" / "python").exists():
        return True
    r = sh(f"uv venv -q --python 3.12 {venv}")
    if r.returncode:
        print("venv failed", r.stderr[-300:]); return False
    cmd = install_cmd.replace("pip install", f"uv pip install -q --python {venv}/bin/python")
    r = sh(cmd, cwd=repo_dir, timeout=900)
    if r.returncode:
        print("install failed", r.stderr[-400:]); return False
    sh(f"uv pip install -q --python {venv}/bin/python pytest hypothesis", cwd=repo_dir)
    return True


def test_node_ids(repo: Path, sha: str, test_files: list[str]) -> list[str]:
    """pytest node ids for the test functions the fix added or changed (falls back to whole files)."""
    import re as _re
    ids = []
    for tf in test_files:
        diff = sh(f"git diff -U0 {sha}^ {sha} -- {tf}", repo).stdout
        new_ranges = []
        for m in _re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", diff, _re.M):
            start, count = int(m.group(1)), int(m.group(2) or 1)
            if count:
                new_ranges.append((start, start + count - 1))
        try:
            tree = ast.parse(sh(f"git show {sha}:{tf}", repo).stdout)
        except SyntaxError:
            ids.append(tf); continue
        found = set()
        def visit(node, prefix):
            for ch in getattr(node, "body", []):
                if isinstance(ch, ast.ClassDef):
                    visit(ch, prefix + [ch.name])
                elif isinstance(ch, (ast.FunctionDef, ast.AsyncFunctionDef)) and ch.name.startswith("test"):
                    s0 = min([d.lineno for d in ch.decorator_list] + [ch.lineno])
                    if any(s0 <= b and a <= ch.end_lineno for a, b in new_ranges):
                        found.add("::".join([tf] + prefix + [ch.name]))
        visit(tree, [])
        ids.extend(sorted(found) if found else [tf])
    return ids


def run_tests(wt: Path, venv: Path, tests: list[str], timeout=45) -> int:
    pp = f"{wt}/src:{wt}" if (wt / "src").is_dir() else str(wt)
    try:
        r = sh(f"PYTHONPATH={pp} {venv}/bin/python -m pytest -x -q -p no:cacheprovider {' '.join(tests)}",
               cwd=wt, timeout=timeout)
        return r.returncode
    except subprocess.TimeoutExpired:
        return 124


def prepare(args):
    from bugcensus.seed import apply_decoys, candidate_decoys

    install = {}
    for raw in Path(args.repos).read_text().splitlines():
        if raw.strip() and not raw.startswith("#") and "|" in raw:
            url, cmd = (x.strip() for x in raw.split("|", 1))
            install[url] = cmd
    bugs = [json.loads(l) for l in Path(args.bugs).read_text().splitlines() if l.strip()]
    if args.max_per_repo:
        per, capped = defaultdict(int), []
        for b in random.Random(1).sample(bugs, len(bugs)):
            if per[b["name"]] < args.max_per_repo:
                per[b["name"]] += 1; capped.append(b)
        bugs = capped
    if args.limit:
        bugs = bugs[: args.limit]
    work = Path(args.work).expanduser(); work.mkdir(parents=True, exist_ok=True)
    done = set()
    out_path = Path(args.out)
    if out_path.exists():
        done = {json.loads(l)["bug_id"] for l in out_path.read_text().splitlines() if l.strip()}
    skip_path = Path(str(out_path) + ".skip")
    if skip_path.exists():
        done |= set(skip_path.read_text().split())

    def skip(bug_id, why):
        print(f"SKIP {bug_id}: {why}", flush=True)
        with skip_path.open("a") as sf:
            sf.write(bug_id + "\n")

    rng = random.Random(0)
    with out_path.open("a") as out:
        for b in bugs:
            bug_id = f"{b['name']}@{b['sha'][:10]}"
            if bug_id in done:
                continue
            print(f"...  {bug_id}", flush=True)
            deadline = time.time() + args.bug_budget
            repo = work / b["name"]
            if not repo.exists():
                shutil.copytree(Path(args.raw) / b["name"], repo, symlinks=True)
            venv = work / f"venv-{b['name']}"
            if not ensure_env(repo, venv, install.get(b["repo"], "pip install -e . pytest")):
                skip(bug_id, "env"); continue
            wt = work / "wt"
            sh(f"git worktree remove --force {wt}", repo); shutil.rmtree(wt, ignore_errors=True)
            if sh(f"git worktree add -q --detach {wt} {b['sha']}", repo).returncode:
                skip(bug_id, "worktree"); continue
            try:
                tests = test_node_ids(repo, b["sha"], b["test_files"])
                if run_tests(wt, venv, tests) != 0:
                    skip(bug_id, "fixed tests fail here"); continue
                units = []
                ok = True
                for src in b["src_files"]:
                    fixed = (wt / src).read_text()
                    parent = sh(f"git show {b['sha']}^:{src}", repo).stdout
                    funcs = [f for f in b["functions"] if f["file"] == src]
                    if not funcs:
                        continue
                    pr = [find_func(parent, f["name"], f["start"]) for f in funcs]
                    fr = [find_func(fixed, f["name"], f["start"]) for f in funcs]
                    if None in pr or None in fr:
                        ok = False; break
                    p_text, p_map = snippet(parent, pr)
                    f_text, f_map = snippet(fixed, fr)
                    real_lines = changed_lines(p_text, f_text)
                    if not real_lines:
                        ok = False; break
                    # re-confirm the bug in THIS environment: parent version must fail the fix tests
                    (wt / src).write_text(parent)
                    still_fails = run_tests(wt, venv, tests) != 0
                    (wt / src).write_text(fixed)
                    if not still_fails:
                        ok = False; break
                    units.append({"bug_id": bug_id, "unit_id": f"{bug_id}:real:{src}", "kind": "real",
                                  "family": "real", "file": src, "snippet": p_text, "bug_lines": real_lines,
                                  "subject": b["subject"]})
                    # decoys in the fixed function(s), kept only if the fix's test fails on them
                    cands = [d for d in candidate_decoys(fixed, fr)]
                    rng.shuffle(cands)
                    kept, kinds = [], set()
                    for d in sorted(cands, key=lambda x: x.kind in kinds)[: args.tries]:
                        if len(kept) >= args.keep or time.time() > deadline:
                            break
                        if d.kind in kinds:
                            continue
                        mutated = apply_decoys(fixed, [d])
                        (wt / src).write_text(mutated)
                        rc = run_tests(wt, venv, tests)
                        (wt / src).write_text(fixed)
                        if rc not in (0, 124):
                            m_text, m_map = snippet(mutated, [find_func(mutated, f["name"], f["start"]) or (1, 1) for f in funcs])
                            line = d.final_line
                            rel = m_map.get(line)
                            if rel is None:
                                continue
                            kinds.add(d.kind)
                            kept.append({"bug_id": bug_id, "unit_id": f"{bug_id}:decoy{len(kept)}:{src}",
                                         "kind": "decoy", "family": d.kind, "file": src, "snippet": m_text,
                                         "bug_lines": [rel], "decoy": d.describe()})
                    units.extend(kept)
                if ok and any(u["kind"] == "decoy" for u in units):
                    for u in units:
                        out.write(json.dumps(u) + "\n")
                    out.flush()
                    print(f"OK   {bug_id}: {sum(u['kind']=='decoy' for u in units)} decoys  ({b['subject'][:50]})", flush=True)
                else:
                    skip(bug_id, "no test-failing decoy" if ok else "could not map bug")
            finally:
                sh(f"git worktree remove --force {wt}", repo); shutil.rmtree(wt, ignore_errors=True)


# ------------------------------------------------------------------------------------ review

def review(args):
    from bugcensus.config import panel_names
    from bugcensus.review import LLMReviewer

    units = [json.loads(l) for l in Path(args.units).read_text().splitlines() if l.strip()]
    if args.limit_units:
        units = units[: args.limit_units]
    reg = registry()
    reviewers = [LLMReviewer(reg[n], usage_log=Path("logs/usage.jsonl")) for n in (args.panel or ",".join(panel_names())).split(",")]
    out_path = Path(args.out)
    done = set()
    if out_path.exists():
        done = {(r["unit_id"], r["reviewer"]) for r in map(json.loads, out_path.read_text().splitlines()) if r.get("error") is None}
    jobs = [(u, r) for u in units for r in reviewers if (u["unit_id"], r.name) not in done]
    print(f"{len(jobs)} review calls")

    def run(job):
        u, r = job
        res = r.review(Path(u["file"]).name, u["snippet"], u["unit_id"])
        return {"unit_id": u["unit_id"], "reviewer": r.name, "error": res.error,
                "findings": [f.__dict__ for f in res.findings],
                "input_tokens": res.input_tokens, "output_tokens": res.output_tokens,
                "seconds": round(res.seconds, 1), "ts": time.time(), "prompt_sha": PROMPT_SHA,
                "model": describe(r.spec)}

    if any(r.spec.local for r in reviewers):
        args.workers = 1   # local models serve one request at a time
    with out_path.open("a") as out, ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, row in enumerate(pool.map(run, jobs), 1):
            out.write(json.dumps(row) + "\n"); out.flush()
            if i % 10 == 0 or row["error"]:
                print(f"{i}/{len(jobs)}" + (f"  ERROR {row['error'][:120]}" if row["error"] else ""))


# ------------------------------------------------------------------------------------ analyze

def caught(findings, lines):
    for f in findings:
        if f["end_line"] - f["start_line"] + 1 > MAX_SPAN:
            continue
        if any(f["start_line"] - 1 <= ln <= f["end_line"] + 1 for ln in lines):
            return True
    return False


def analyze(args):
    import numpy as np

    units = {u["unit_id"]: u for u in map(json.loads, Path(args.units).read_text().splitlines()) if u}
    rows = [json.loads(l) for l in Path(args.reviews).read_text().splitlines() if l.strip()]
    rows = [r for r in rows if r.get("error") is None and r["unit_id"] in units]
    if args.reviewers:
        keep = set(args.reviewers.split(","))
        rows = [r for r in rows if r["reviewer"] in keep]
    hit = defaultdict(dict)       # unit -> reviewer -> bool
    for r in rows:
        hit[r["unit_id"]][r["reviewer"]] = caught(r["findings"], units[r["unit_id"]]["bug_lines"])
    reviewers = sorted({r["reviewer"] for r in rows})
    complete = [u for u in hit if set(hit[u]) == set(reviewers)]
    bugs = sorted({units[u]["bug_id"] for u in complete})
    out_tokens = sum(r["output_tokens"] or 0 for r in rows)
    print(f"bugs {len(bugs)}  units {len(complete)}  reviewers {reviewers}  output tokens {out_tokens}")

    def rates(bug_sample, who):
        out = {}
        for kind in ("real", "decoy"):
            vals = []
            for b in bug_sample:
                for u in complete:
                    if units[u]["bug_id"] == b and units[u]["kind"] == kind:
                        vals.append(any(hit[u].values()) if who == "panel" else hit[u][who])
            out[kind] = (np.mean(vals) if vals else np.nan, len(vals))
        return out

    lg = lambda p: np.log(np.clip(p, 0.02, 0.98) / (1 - np.clip(p, 0.02, 0.98)))
    rng = np.random.default_rng(0)
    result = {"schema_version": 2, "kind": "realism", "name": args.name or Path(args.reviews).stem,
              "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
              "units_file": args.units, "reviews_file": args.reviews,
              "bugs": len(bugs), "units": len(complete),
              "repos": len({units[u]["bug_id"].split("@")[0] for u in complete}),
              "max_span": MAX_SPAN, "output_tokens": out_tokens,
              "models": _models(rows, reviewers), "reviewers": [], "miss_all": {}, "families": []}
    print(f"\n{'reviewer':8s} {'real caught':>14s} {'decoy caught':>14s} {'gap (logit)':>12s} {'95% CI':>16s}")
    for who in reviewers + ["panel"]:
        r = rates(bugs, who)
        gap = lg(r["decoy"][0]) - lg(r["real"][0])
        boots = []
        for _ in range(2000):
            sample = list(rng.choice(bugs, len(bugs)))
            rb = rates(sample, who)
            boots.append(lg(rb["decoy"][0]) - lg(rb["real"][0]))
        lo, hi = np.nanpercentile(boots, [2.5, 97.5])
        print(f"{who:8s} {r['real'][0]:8.0%} (n={r['real'][1]:3d}) {r['decoy'][0]:8.0%} (n={r['decoy'][1]:3d}) "
              f"{gap:+12.2f} [{lo:+.2f}, {hi:+.2f}]")
        result["reviewers"].append({"reviewer": who, "real_rate": float(r["real"][0]), "real_n": r["real"][1],
                                    "decoy_rate": float(r["decoy"][0]), "decoy_n": r["decoy"][1],
                                    "gap_logit": float(gap), "ci_low": float(lo), "ci_high": float(hi)})
    print("\nPanel MISS-ALL rate (what the estimator uses):")
    for kind in ("real", "decoy"):
        v = [not any(hit[u].values()) for u in complete if units[u]["kind"] == kind]
        print(f"  {kind:5s} {np.mean(v):.0%} of {len(v)}")
        result["miss_all"][kind] = {"rate": float(np.mean(v)), "n": len(v)}
    print("\nDecoy detection by family (panel):")
    fam = defaultdict(list)
    for u in complete:
        if units[u]["kind"] == "decoy":
            fam[units[u]["family"]].append(any(hit[u].values()))
    for k, v in sorted(fam.items(), key=lambda kv: -len(kv[1])):
        print(f"  {k:13s} {np.mean(v):5.0%} of {len(v)}")
        result["families"].append({"family": k, "rate": float(np.mean(v)), "n": len(v)})
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=2))
        print(f"\nwrote {args.json}")
    if not args.no_push:
        from bugcensus.cli import _push

        _push(result, "realism")


def _models(rows, reviewers):
    """Model details per reviewer. Rows written before Oct 27 carry only the reviewer name, so their
    model is taken from today's registry defaults and marked inferred."""
    seen = {}
    for r in rows:
        if r.get("model") and r["reviewer"] not in seen:
            seen[r["reviewer"]] = {**r["model"], "inferred": False}
    reg = registry()
    for who in reviewers:
        if who not in seen and who in reg:
            seen[who] = {**describe(reg[who]), "inferred": True}
    return [seen[w] for w in reviewers if w in seen]


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--bugs", default="data/bugs.jsonl"); p.add_argument("--repos", default="scripts/repos.txt")
    p.add_argument("--raw", default="data/raw"); p.add_argument("--work", default="~/rc")
    p.add_argument("--out", default="data/realism_units.jsonl"); p.add_argument("--limit", type=int, default=0)
    p.add_argument("--max-per-repo", type=int, default=0)
    p.add_argument("--bug-budget", type=int, default=90, help="seconds of decoy tries per bug")
    p.add_argument("--tries", type=int, default=TRIES); p.add_argument("--keep", type=int, default=KEEP)
    p.set_defaults(func=prepare)
    r = sub.add_parser("review")
    r.add_argument("--units", default="data/realism_units.jsonl"); r.add_argument("--out", default="data/realism_reviews.jsonl")
    r.add_argument("--panel", default=None); r.add_argument("--workers", type=int, default=6)
    r.add_argument("--limit-units", type=int, default=0, help="review only the first N units (cost control)")
    r.set_defaults(func=review)
    a = sub.add_parser("analyze")
    a.add_argument("--units", default="data/realism_units.jsonl"); a.add_argument("--reviews", default="data/realism_reviews.jsonl")
    a.add_argument("--reviewers", default=None, help="only these reviewers, e.g. spark,glimmer")
    a.add_argument("--name", default=None, help="experiment name shown in the dashboard")
    a.add_argument("--json", default=None, help="also write the results to this JSON file")
    a.add_argument("--no-push", action="store_true", help="don't send results to the dashboard")
    a.set_defaults(func=analyze)
    args = ap.parse_args(); args.func(args)


if __name__ == "__main__":
    main()
