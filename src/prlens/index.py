"""prlens index: add confirmed bugs (from `prlens validate`) to data/bug_fixes.jsonl, which `prlens trace` reads.

    prlens index --bugs data/bugs_ts.jsonl

One row per bug: the source file the fix changed most is the one traced back. Bugs already in the index are kept
as they are (safe to repeat).
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from pathlib import Path

from .bugdata import INDEX, find_repo


def primary_file(repo: Path, sha: str, files: list[str]) -> str:
    """The source file with the most changed lines in the fix."""
    if len(files) == 1:
        return files[0]
    best, most = files[0], -1
    for f in files:
        out = subprocess.run(["git", "-C", str(repo), "diff", "--numstat", f"{sha}^", sha, "--", f],
                             capture_output=True, text=True).stdout
        m = re.match(r"(\d+)\s+(\d+)", out)
        n = int(m.group(1)) + int(m.group(2)) if m else 0
        if n > most:
            best, most = f, n
    return best


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bugs", nargs="+", required=True, help="confirmed bug files from prlens validate")
    ap.add_argument("--index", default=str(INDEX))
    args = ap.parse_args(argv)
    index = Path(args.index)
    have = set()
    if index.exists():
        have = {json.loads(l)["bug_id"] for l in index.read_text().splitlines() if l.strip()}
    added, missing = 0, 0
    with open(index, "a") as out:
        for f in args.bugs:
            for line in Path(f).read_text().splitlines():
                if not line.strip():
                    continue
                c = json.loads(line)
                bug_id = f"{c['name']}@{c['sha'][:10]}"
                if bug_id in have:
                    continue
                repo = find_repo(c["name"])
                if repo is None:
                    missing += 1
                    continue
                out.write(json.dumps({
                    "bug_id": bug_id, "repo": c["name"], "repo_url": c["repo"], "language": c.get("language", "python"),
                    "sha": c["sha"], "file": primary_file(repo, c["sha"], c["src_files"]), "src_files": c["src_files"],
                    "test_files": c["test_files"], "subject": c["subject"], "date": c.get("date"),
                }) + "\n")
                have.add(bug_id)
                added += 1
    print(f"added {added} bugs to {index}" + (f"; {missing} skipped (no clone found)" if missing else ""))
