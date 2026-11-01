"""Mine recent bug-fix commits that come with a test: the raw material for the evaluation PRs.

Keeps a commit only if it:
  - is not a merge and its message mentions fix/bug/regression/crash;
  - is newer than --since (prefer dates after the models' training data, to avoid "remembered" bugs);
  - changes 1-2 non-test source files of the language, at most --max-src-lines lines in them
    (Python: also at most 2 functions in the pre-fix version);
  - changes or adds at least one test file of the language (the test proves the bug is real; `prlens validate`
    checks it).

Usage:
  prlens mine --repos data/repos/typescript.txt --language typescript --since 2025-06-01 --out data/candidates_ts.jsonl
Repository lists: one `url | install command | test command` per line (the last two optional; {files} in the test
command is replaced by the changed test files). Output: one JSON object per candidate commit.
"""
from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
from pathlib import Path

from .languages import LANGUAGES, is_test, language_of

FIX_RE = r"fix|bug|regression|crash|incorrect|wrong"


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


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
                    key = (a, b)  # keep the innermost function for this range
                    prev = hits.get(key)
                    if prev is None or node.lineno >= prev.lineno:
                        hits[key] = node
    names = {(n.name, n.lineno, n.end_lineno) for n in hits.values()}
    return [{"name": n, "start": s, "end": e} for n, s, e in sorted(names, key=lambda x: x[1])]


def mine_repo(url: str, workdir: Path, since: str, max_src_lines: int, language: str) -> list[dict]:
    lang = LANGUAGES[language]
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
            if len(parts) != 3 or language_of(parts[2]) is not lang:
                continue
            added, deleted, path = parts
            if is_test(path):
                tests.append(path)
            else:
                src.append(path)
                src_lines += int(added if added.isdigit() else 0) + int(deleted if deleted.isdigit() else 0)
        if not tests or not (1 <= len(src) <= 2) or src_lines > max_src_lines:
            continue
        funcs, new_file = [], False
        for path in src:
            try:
                old = git(repo, "show", f"{sha}^:{path}")
            except subprocess.CalledProcessError:
                new_file = True  # new file: not a bug fix in existing code
                break
            if language == "python":
                funcs += [{"file": path, **f} for f in functions_touched(old, changed_ranges_old(repo, sha, path))]
        if new_file or (language == "python" and not (1 <= len(funcs) <= 2)):
            continue
        out.append({"repo": url, "name": name, "language": language, "sha": sha, "date": date, "subject": subject,
                    "src_files": src, "test_files": tests, "src_lines_changed": src_lines, "functions": funcs})
    return out


def repo_lines(path: str) -> list[list[str]]:
    rows = []
    for raw in Path(path).read_text().splitlines():
        raw = raw.strip()
        if raw and not raw.startswith("#"):
            rows.append([x.strip() for x in raw.split("|")])
    return rows


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repos", default="data/repos/repos.txt")
    ap.add_argument("--language", choices=sorted(LANGUAGES), default="python")
    ap.add_argument("--since", default="2026-06-01")
    ap.add_argument("--out", default="data/candidates.jsonl")
    ap.add_argument("--workdir", default="data/raw")
    ap.add_argument("--max-src-lines", type=int, default=40)
    args = ap.parse_args(argv)
    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    total = 0
    with open(args.out, "w") as f:
        for row in repo_lines(args.repos):
            url = row[0]
            try:
                rows = mine_repo(url, workdir, args.since, args.max_src_lines, args.language)
            except subprocess.CalledProcessError as exc:
                print(f"{url}: git failed: {exc.stderr[:200] if exc.stderr else exc}", flush=True)
                continue
            for r in rows:
                f.write(json.dumps(r) + "\n")
            total += len(rows)
            print(f"{url}: {len(rows)} candidates", flush=True)
    print(f"total {total} candidates -> {args.out}")
