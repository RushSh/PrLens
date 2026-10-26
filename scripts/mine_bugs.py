"""Mine recent bug-fix commits that come with a test, for the realism test and calibration plot.

Keeps a commit only if it:
  - is not a merge and its message mentions fix/bug/regression/crash;
  - is newer than --since (after the models' training data, to avoid "remembered" bugs);
  - changes 1-2 non-test Python source files, at most --max-src-lines lines in them,
    touching at most 2 functions (in the pre-fix version);
  - changes or adds at least one test file (the test proves the bug is real; checked by validate_bugs.py).

Usage:
  python scripts/mine_bugs.py --repos scripts/repos.txt --since 2026-06-01 --out data/candidates.jsonl
Output: one JSON object per candidate commit.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
from pathlib import Path

FIX_RE = r"fix|bug|regression|crash|incorrect|wrong"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def is_test(path: str) -> bool:
    name = Path(path).name
    return "test" in Path(path).parts[0:-1] or name.startswith("test_") or name.endswith("_test.py") \
        or "/tests/" in f"/{path}" or "/test/" in f"/{path}"


def changed_ranges_old(repo: Path, sha: str, path: str) -> list[tuple[int, int]]:
    """Line ranges in the PARENT version of `path` touched by commit `sha` (from -U0 hunk headers)."""
    diff = git(repo, "diff", "-U0", f"{sha}^", sha, "--", path)
    out = []
    for m in re.finditer(r"^@@ -(\d+)(?:,(\d+))? \+", diff, re.M):
        start, count = int(m.group(1)), int(m.group(2) or 1)
        out.append((start, start + max(count, 1) - 1))
    return out


def functions_touched(source: str, ranges: list[tuple[int, int]]) -> list[dict]:
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return []
    hits = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for a, b in ranges:
                if node.lineno <= b and a <= node.end_lineno:
                    # keep the innermost function for this range
                    key = (a, b)
                    prev = hits.get(key)
                    if prev is None or node.lineno >= prev.lineno:
                        hits[key] = node
    names = {(n.name, n.lineno, n.end_lineno) for n in hits.values()}
    return [{"name": n, "start": s, "end": e} for n, s, e in sorted(names, key=lambda x: x[1])]


def mine_repo(url: str, workdir: Path, since: str, max_src_lines: int) -> list[dict]:
    name = url.rstrip("/").split("/")[-1].removesuffix(".git")
    repo = workdir / name
    if not repo.exists():
        subprocess.run(["git", "clone", "--quiet", "--filter=blob:none", url, str(repo)], check=True)
    else:
        subprocess.run(["git", "-C", str(repo), "pull", "--quiet"], check=False)
    log = git(repo, "log", f"--since={since}", "--no-merges", "-i", "-E", f"--grep={FIX_RE}",
              "--format=%H%x09%cI%x09%s")
    out = []
    for line in log.splitlines():
        sha, date, subject = line.split("\t", 2)
        stats = git(repo, "show", "--numstat", "--format=", sha).splitlines()
        src, tests, src_lines = [], [], 0
        for row in stats:
            parts = row.split("\t")
            if len(parts) != 3 or not parts[2].endswith(".py"):
                continue
            added, deleted, path = parts
            if is_test(path):
                tests.append(path)
            else:
                src.append(path)
                src_lines += int(added if added.isdigit() else 0) + int(deleted if deleted.isdigit() else 0)
        if not tests or not (1 <= len(src) <= 2) or src_lines > max_src_lines:
            continue
        funcs = []
        for path in src:
            try:
                old = git(repo, "show", f"{sha}^:{path}")
            except subprocess.CalledProcessError:
                funcs = []  # new file: not a bug fix in existing code
                break
            for f in functions_touched(old, changed_ranges_old(repo, sha, path)):
                funcs.append({"file": path, **f})
        if not (1 <= len(funcs) <= 2):
            continue
        out.append({"repo": url, "name": name, "sha": sha, "date": date, "subject": subject,
                    "src_files": src, "test_files": tests, "src_lines_changed": src_lines, "functions": funcs})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repos", default="scripts/repos.txt")
    ap.add_argument("--since", default="2026-06-01")
    ap.add_argument("--out", default="data/candidates.jsonl")
    ap.add_argument("--workdir", default="data/raw")
    ap.add_argument("--max-src-lines", type=int, default=40)
    args = ap.parse_args()
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(args.out, "w") as f:
        for raw in Path(args.repos).read_text().splitlines():
            raw = raw.strip()
            if not raw or raw.startswith("#"):
                continue
            url = raw.split("|")[0].strip()
            try:
                rows = mine_repo(url, workdir, args.since, args.max_src_lines)
            except subprocess.CalledProcessError as exc:
                print(f"{url}: git failed: {exc.stderr[:200] if exc.stderr else exc}")
                continue
            for r in rows:
                f.write(json.dumps(r) + "\n")
            total += len(rows)
            print(f"{url}: {len(rows)} candidates")
    print(f"total {total} candidates -> {args.out}")


if __name__ == "__main__":
    main()
