"""Mined bug fixes as data: where each lives, its buggy and fixed function text, and helpers to cut functions
out of a file. Shared by the realism check, calibration, decoy writers and the judge.

The bug index (data/bug_fixes.jsonl) is built once from the realism units, the mined records and the repository
clones (git only): `python scripts/decoys.py index`."""
from __future__ import annotations

import ast
import difflib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "data" / "bug_fixes.jsonl"
DEFAULT_RECORDS = [ROOT / "data" / "bugs.jsonl", ROOT / "data" / "candidates2.jsonl"]
DEFAULT_RAW = [ROOT / "data" / "raw", Path("~/raw2").expanduser()]


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
    """Lines (1-based) in old_text that differ from new_text; insertions mark the neighbouring lines."""
    old, new = old_text.splitlines(), new_text.splitlines()
    marks = set()
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, old, new, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            marks.update(range(i1 + 1, i2 + 1))
        elif tag == "insert":
            marks.update(x for x in (i1, i1 + 1) if 1 <= x <= len(old))
    return sorted(marks)


def unified(old: str, new: str, context: int = 2) -> str:
    """A compact diff for showing a change to a model or a person."""
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "before", "after", n=context))


def git_show(repo: Path, spec: str) -> str | None:
    r = subprocess.run(["git", "show", spec], cwd=repo, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def find_repo(name: str, raw_dirs=None) -> Path | None:
    for d in raw_dirs or DEFAULT_RAW:
        d = Path(d).expanduser()
        if (d / name / ".git").exists():
            return d / name
    return None


def load_records(paths=None) -> dict[str, dict]:
    records = {}
    for p in paths or DEFAULT_RECORDS:
        p = Path(p)
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                records[f"{r['name']}@{r['sha'][:10]}"] = r
    return records


def build_index(realism_units: Path, out: Path = INDEX, raw_dirs=None, records=None) -> tuple[int, dict]:
    """One row per bug that has a realism REAL unit: buggy and fixed text of the touched function(s)."""
    from collections import Counter, defaultdict

    recs = load_records(records)
    by_bug = defaultdict(list)
    for line in realism_units.read_text().splitlines():
        if line.strip():
            u = json.loads(line)
            by_bug[u["bug_id"]].append(u)
    rows, skipped = [], Counter()
    for bug_id, us in sorted(by_bug.items()):
        real = [u for u in us if u["kind"] == "real"]
        rec = recs.get(bug_id)
        repo = find_repo(bug_id.split("@")[0], raw_dirs) if rec else None
        if len(real) != 1:
            skipped["multi-file fix"] += 1
            continue
        if not rec or not repo:
            skipped["no record or clone"] += 1
            continue
        real = real[0]
        src = real["file"]
        fixed_src = git_show(repo, f"{rec['sha']}:{src}")
        funcs = [f for f in rec["functions"] if f["file"] == src]
        ranges = [find_func(fixed_src, f["name"], f["start"]) for f in funcs] if fixed_src else [None]
        if None in ranges:
            skipped["function not found"] += 1
            continue
        fixed, _ = snippet(fixed_src, ranges)
        rows.append({"bug_id": bug_id, "repo": rec["name"], "repo_url": rec["repo"], "sha": rec["sha"], "file": src,
                     "functions": funcs, "fixed_ranges": ranges, "test_files": rec["test_files"],
                     "subject": rec.get("subject", ""), "buggy": real["snippet"], "fixed": fixed,
                     "fix_lines": real["bug_lines"], "diff": unified(real["snippet"], fixed)})
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    return len(rows), dict(skipped)


def load_index(path: Path = INDEX) -> dict[str, dict]:
    if not path.exists():
        raise SystemExit(f"{path} is missing; build it with: python scripts/decoys.py index")
    return {r["bug_id"]: r for r in map(json.loads, path.read_text().splitlines()) if r}
