"""Real PRs with known bugs, for the PR Reviewer triage.

    prlens trace      # mined bug fixes -> the commits that introduced them -> data/triage/prs.jsonl
    prlens baseline   # free baseline: no-model rules + simple rankings, against the gate

Trace-back (SZZ): for each fix, `git blame` the lines the fix deleted or changed, as they stood just before the fix
(ignoring whitespace, blank and comment lines). The commit most of them come from introduced the bug. A fix that only
adds lines is traced through the line just above the insertion and marked `adjacent` (weaker evidence).
That commit's full diff becomes a PR; the hunks holding the blamed lines are its bug hunks.

No model is called. Everything runs on the local git clones.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path


from .bugdata import DEFAULT_RAW, INDEX, ROOT, find_repo as _find_repo
from .hunks import Hunk, defs_in, parse_diff, proof, regions, review_rules, skip_category
from .languages import is_test as is_test_path, language_of, logic_density as lang_logic_density

OUT = ROOT / "data" / "triage" / "prs.jsonl"
CACHE = ROOT / "data" / "work" / "trace_blame.json"
MAX_FILES = 30
MAX_LINES = 1500
# git on a shared folder is slow; a local copy of data/raw (~/rawlocal) is used first when present
RAW_DIRS = [Path("~/rawlocal").expanduser(), *DEFAULT_RAW]


def find_repo(name: str):
    return _find_repo(name, RAW_DIRS)


REFORMAT_RE = re.compile(r"\b(black|ruff format|reformat|isort|pre-commit autoupdate|blacken|pyupgrade|autopep8|prettier|biome format|eslint --fix|dotnet format|lint fixes)\b", re.I)


class GitTimeout(Exception):
    pass


def git(repo: Path, *args: str, timeout: float | None = None) -> str | None:
    try:
        r = subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True, errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as e:
        raise GitTimeout(" ".join(args[:2])) from e
    return r.stdout if r.returncode == 0 else None


def fix_old_lines(repo: Path, fix: str, path: str) -> tuple[list[int], bool]:
    """Old-side line numbers the fix deleted or changed in `path`; (lines, adjacent)."""
    d = git(repo, "diff", "-U0", "-w", f"{fix}^", fix, "--", path) or ""
    deleted, inserts = [], []
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", d, re.M):
        start, n = int(m.group(1)), int(m.group(2)) if m.group(2) is not None else 1
        if n:
            deleted += range(start, start + n)
        else:
            inserts.append(start)  # pure insertion after old line `start`
    if deleted:
        return deleted, False
    return [s for s in inserts if s > 0], True


def blame(repo: Path, rev: str, path: str, lines: list[int]) -> list[dict]:
    """One record per line: commit, the file name and line number in that commit, and the text."""
    if not lines:
        return []
    args = ["blame", "--line-porcelain", "-w"]
    ls = sorted(set(lines))
    start = prev = ls[0]
    for a in ls[1:] + [None]:
        if a is not None and a == prev + 1:
            prev = a
            continue
        args += ["-L", f"{start},{prev}"]
        if a is not None:
            start = prev = a
    out = git(repo, *args, rev, "--", path, timeout=45)
    if out is None:
        return []
    recs, cur = [], None
    for line in out.splitlines():
        m = re.match(r"^([0-9a-f]{40}) (\d+) (\d+)", line)
        if m:
            cur = {"sha": m.group(1), "orig_line": int(m.group(2)), "line": int(m.group(3))}
        elif cur is not None and line.startswith("filename "):
            cur["file"] = line[9:]
        elif cur is not None and line.startswith("\t"):
            cur["text"] = line[1:]
            recs.append(cur)
            cur = None
    return recs


PY_TRIVIAL = {"(", ")", "[", "]", "{", "}", "):", "else:", "try:", "pass"}
C_TRIVIAL = {"(", ")", "[", "]", "{", "}", "};", "});", ");", "},", "})", "]);", "else", "else {", "} else {", "try", "try {",
             "finally", "finally {", "default:", "break;"}


def meaningful(text: str, path: str = "") -> bool:
    """Lines worth blaming: not blank, not comments, not lone brackets (per language; Python's rule is unchanged)."""
    t = text.strip()
    lang = language_of(path) if path else None
    if lang is None or lang.name == "python":
        return bool(t) and not t.startswith("#") and t not in PY_TRIVIAL
    return bool(t) and not t.startswith(("//", "/*", "*")) and t not in C_TRIVIAL


def is_root(repo: Path, sha: str) -> bool:
    return git(repo, "rev-parse", "--verify", "-q", f"{sha}^") is None


def trace(args) -> None:
    bugs = [json.loads(l) for l in open(INDEX)]
    drop = Counter()
    prs: dict[tuple[str, str], dict] = {}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    deadline = time.time() + args.budget
    todo = [b for b in bugs if b["bug_id"] not in cache]
    for i, b in enumerate(todo):
        if i:
            CACHE.write_text(json.dumps(cache))  # every bug: a call cut short still keeps its progress
        if time.time() > deadline:
            print(f"blamed {len(cache)}/{len(bugs)} fixes so far; run again to continue", flush=True)
            return
        repo = find_repo(b["repo"])
        if repo is None:
            cache[b["bug_id"]] = None
            continue
        old, adjacent = fix_old_lines(repo, b["sha"], b["file"])
        try:
            cache[b["bug_id"]] = {"adjacent": adjacent, "recs": blame(repo, f"{b['sha']}^", b["file"], old)}
        except GitTimeout:
            cache[b["bug_id"]] = {"adjacent": adjacent, "recs": [], "timeout": True}
        CACHE.write_text(json.dumps(cache))
    CACHE.write_text(json.dumps(cache))
    for b in bugs:
        repo = find_repo(b["repo"])
        if repo is None or cache.get(b["bug_id"]) is None:
            drop["no clone"] += 1
            continue
        adjacent = cache[b["bug_id"]]["adjacent"]
        recs = [r for r in cache[b["bug_id"]]["recs"] if meaningful(r.get("text", ""), b["file"])]
        if cache[b["bug_id"]].get("timeout"):
            drop["blame took over 45 s"] += 1
            continue
        if not recs:
            drop["nothing to blame"] += 1
            continue
        votes = Counter(r["sha"] for r in recs)
        sha, _ = votes.most_common(1)[0]
        if is_root(repo, sha):
            drop["traced to first commit"] += 1
            continue
        subject = (git(repo, "log", "-1", "--format=%s", sha) or "").strip()
        if REFORMAT_RE.search(subject):
            drop["traced to a reformat commit"] += 1
            continue
        if sha.startswith("0" * 40):
            drop["uncommitted"] += 1
            continue
        key = (b["repo"], sha)
        pr = prs.get(key)
        if pr is None:
            diff = git(repo, "diff", "-U3", "-M", "--no-color", f"{sha}^", sha) or ""
            files = parse_diff(diff)
            nfiles = len(files)
            nlines = sum(h.size for f in files for h in f.hunks)
            if nfiles > MAX_FILES or nlines > MAX_LINES:
                drop[f"too big (> {MAX_FILES} files or > {MAX_LINES} lines)"] += 1
                continue
            meta = (git(repo, "log", "-1", "--format=%an%x00%aI%x00%B", sha) or "\0\0").split("\0", 2)
            hunks = []
            pr_defs = defs_in([l for f in files for h in f.hunks for l in h.lines], "add")
            for f in files:
                if f.binary:
                    continue
                old_src = git(repo, "show", f"{sha}^:{f.old_path}") if f.old_path else None
                for i, h in enumerate(f.hunks):
                    skip = skip_category(h, old_src)
                    # layout- or docstring-only: blame landing here is SZZ noise, whether or not the hunk is skipped
                    neutral = proof(old_src, h) in ("formatting", "docs")
                    regs = []
                    for j, r in enumerate(regions(h)):
                        regs.append({"id": f"{h.file}#{i}.{j}", "added": r.added, "removed": r.removed,
                                     "new_lines": sorted(r.new_lines()),
                                     "old_lines": sorted(l.old for l in r.lines if l.kind == "del"), "rules": review_rules(r, pr_defs),
                                     "bug": False})
                    hunks.append({
                        "id": f"{h.file}#{i}",
                        "file": h.file,
                        "header": h.header,
                        "added": h.added,
                        "removed": h.removed,
                        "new_start": h.new_start,
                        "new_len": h.new_len,
                        "lines": [[l.kind, l.old, l.new, l.text] for l in h.lines],
                        "skip": skip,
                        "neutral": neutral,
                        "rules": review_rules(h, pr_defs),
                        "regions": regs,
                        "bug": False,
                        "bug_ids": [],
                    })
            pr = prs[key] = {
                "pr_id": f"{b['repo']}@{sha[:10]}",
                "repo": b["repo"],
                "language": b.get("language", "python"),
                "sha": sha,
                "subject": subject,
                "message": meta[2].strip() if len(meta) > 2 else subject,
                "author": meta[0],
                "date": meta[1],
                "files": nfiles,
                "lines": nlines,
                "bugs": [],
                "hunks": hunks,
            }
        mine = [r for r in recs if r["sha"] == sha]
        hit, rhit, neutral = set(), set(), 0
        for r in mine:
            for h in pr["hunks"]:
                if h["file"] == r.get("file") and any(
                        l[0] == "add" and l[2] == r["orig_line"] for l in h["lines"]):
                    if h.get("neutral") or (h["skip"] and h["skip"][0] in ("formatting", "docs")):
                        neutral += 1  # the commit only reformatted or re-documented this line: not where the bug came from
                        continue
                    hit.add(h["id"])
                    rhit.update(g["id"] for g in h["regions"] if r["orig_line"] in g["new_lines"])
        if not hit:
            drop["traced to a formatting/docs-only change" if neutral else "blamed lines not found in the PR diff"] += 1
            if not pr["bugs"]:
                del prs[key]
            continue
        for h in pr["hunks"]:
            if h["id"] in hit:
                h["bug"] = True
                h["bug_ids"].append(b["bug_id"])
            for g in h["regions"]:
                if g["id"] in rhit:
                    g["bug"] = True
        pr["bugs"].append({
            "bug_id": b["bug_id"],
            "fix_sha": b["sha"],
            "fix_subject": b.get("subject", ""),
            "evidence": "adjacent" if adjacent else "deleted",
            "vote_share": round(votes[sha] / sum(votes.values()), 2),
            "hunks": sorted(hit),
            "lines": [[r.get("file"), r["orig_line"]] for r in mine],
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as fh:
        for pr in prs.values():
            fh.write(json.dumps(pr) + "\n")
    traced = sum(len(p["bugs"]) for p in prs.values())
    ev = Counter(x["evidence"] for p in prs.values() for x in p["bugs"])
    print(f"{len(bugs)} fixes -> {traced} traced to {len(prs)} PRs in {len({p['repo'] for p in prs.values()})} repos "
          f"(evidence: {dict(ev)})")
    for k, v in drop.most_common():
        print(f"  dropped {v:3d}  {k}")
    sizes = sorted(p["lines"] for p in prs.values())
    if sizes:
        print(f"  PR size (changed lines): median {sizes[len(sizes)//2]}, max {sizes[-1]}; "
              f"by repo {dict(Counter(p['repo'] for p in prs.values()))}")
    print(f"wrote {OUT.relative_to(ROOT)}")


# ---------------------------------------------------------------- free baseline

LOGIC_RE = re.compile(r"(\bif\b|\belif\b|\bwhile\b|\bfor\b|\band\b|\bor\b|\bnot\b|[<>]=?|==|!=|\[[^\]]*:[^\]]*\]|[+-]\s*1\b|\breturn\b|\bexcept\b|\bis\b|\bin\b)")


def logic_density(h: dict) -> float:
    """Logic operators on the changed lines (the language's own; Python's are the combiner's original feature)."""
    changed = [l[3] for l in h["lines"] if l[0] != "ctx" and l[3].strip() and not l[3].strip().startswith(("#", "//"))]
    lang = language_of(h["file"])
    if lang is None or lang.name == "python":
        return sum(len(LOGIC_RE.findall(t)) for t in changed)
    return lang_logic_density(lang, changed)


def is_test(h: dict) -> bool:
    p = h["file"].lower()
    if p.endswith(".py") or language_of(p) is None:
        return "/test" in "/" + p or p.rsplit("/", 1)[-1].startswith("test")  # the rule the Python combiner was fit with
    return is_test_path(h["file"])


def read_until(hunks: list[dict], order: list[dict], budget: float) -> bool:
    """Read forced hunks first, then `order`, while the lines read stay within budget; did we read a bug hunk?"""
    used = 0
    forced = [h for h in hunks if h["rules"] and not h["skip"]]
    seen = set()
    for h in forced + order:
        if h["id"] in seen:
            continue
        seen.add(h["id"])
        if used + h["added"] + h["removed"] > budget:
            continue  # too long to fit; try smaller ones (a reviewer skims to what fits)
        used += h["added"] + h["removed"]
        if h["bug"]:
            return True
    return False


def baseline(args) -> None:
    prs = [json.loads(l) for l in open(OUT)]
    if args.strict:
        prs = [p for p in prs if any(b["evidence"] == "deleted" for b in p["bugs"])]
    rng = random.Random(0)
    n = len(prs)
    tot_lines = sum(p["lines"] for p in prs)
    skipped = [h for p in prs for h in p["hunks"] if h["skip"]]
    false_skip = [h for h in skipped if h["bug"]]
    by_cat = Counter(h["skip"][0] for h in skipped)
    forced = [h for p in prs for h in p["hunks"] if h["rules"] and not h["skip"]]
    forced_bug_prs = sum(any(h["bug"] and h["rules"] and not h["skip"] for h in p["hunks"]) for p in prs)
    print(f"{n} PRs, {sum(len(p['hunks']) for p in prs)} hunks, {tot_lines} changed lines"
          f"{' (strict evidence only)' if args.strict else ''}")
    print(f"\nNo-model skip rules: {len(skipped)} hunks, {sum(h['added']+h['removed'] for h in skipped)} lines "
          f"({sum(h['added']+h['removed'] for h in skipped)/tot_lines:.0%} of all lines) skipped; "
          f"bug hunks wrongly skipped: {len(false_skip)}")
    print("  by category: " + ", ".join(f"{k} {v}" for k, v in by_cat.most_common()))
    for h in false_skip:
        print(f"  !! false skip {h['id']} ({h['skip'][0]})")
    print(f"Must-review rules: {len(forced)} hunks, {sum(h['added']+h['removed'] for h in forced)} lines; "
          f"bug hunk among them in {forced_bug_prs}/{n} PRs; "
          f"by rule {dict(Counter(r[0] for h in forced for r in h['rules']))}")

    share_bug_lines = [sum(h['added']+h['removed'] for h in p['hunks'] if h['bug']) / max(1, p['lines']) for p in prs]
    print(f"Bug hunks are {sum(share_bug_lines)/n:.0%} of a PR's lines on average")

    if args.unit == "region":
        for p in prs:
            units = []
            for h in p["hunks"]:
                for g in h["regions"]:
                    g = dict(g, file=h["file"], skip=h["skip"],
                             lines=[l for l in h["lines"] if (l[2] in g["new_lines"])] or [[ "del", 0, None, ""]])
                    units.append(g)
            p["hunks"] = units
        print(f"\nUnit: regions of up to ~25 changed lines ({sum(len(p['hunks']) for p in prs)} regions)")
        big = sum(1 for p in prs if min((h['added']+h['removed'] for h in p['hunks'] if h['bug']), default=0) > p['lines']/3)
        print(f"PRs whose smallest bug region alone is over 1/3 of the PR: {big}/{n}")
    rankers = {
        "random order": lambda hs: rng.sample(hs, len(hs)),
        "biggest hunk first": lambda hs: sorted(hs, key=lambda h: -(h["added"] + h["removed"])),
        "most logic first": lambda hs: sorted(hs, key=lambda h: -logic_density(h)),
        "logic, source before tests": lambda hs: sorted(hs, key=lambda h: (is_test(h), -logic_density(h))),
    }
    print(f"\nGate: the bug is in what you read, reading at most 1/3 of the PR's lines (target >= 55%)")
    print(f"{'ranking':30s} {'1/3 of lines':>13s} {'1/2 of lines':>13s}")
    for name, rank in rankers.items():
        res = {}
        for frac in (1 / 3, 1 / 2):
            reps = 200 if name == "random order" else 1
            hits = 0
            for _ in range(reps):
                for p in prs:
                    cand = [h for h in p["hunks"] if not h["skip"]]
                    hits += read_until(p["hunks"], rank(cand), frac * p["lines"])
            res[frac] = hits / (reps * n)
        print(f"{name:30s} {res[1/3]:13.0%} {res[1/2]:13.0%}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("trace")
    t.add_argument("--budget", type=float, default=150, help="seconds of blaming per call; rerun to continue")
    t.set_defaults(fn=trace)
    b = sub.add_parser("baseline")
    b.add_argument("--strict", action="store_true", help="only PRs traced from deleted/changed lines")
    b.add_argument("--unit", choices=["hunk", "region"], default="hunk")
    b.set_defaults(fn=baseline)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
