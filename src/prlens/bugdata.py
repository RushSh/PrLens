"""Where the mined bug fixes and the repository clones live.

data/bug_fixes.jsonl holds one confirmed bug fix per line (repo, fix commit, file, changed lines); the clones are
plain git checkouts under data/raw/ or ~/raw2/ (git only, nothing is installed). `prlens trace` reads both.
"""
from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = ROOT / "data" / "bug_fixes.jsonl"
DEFAULT_RAW = [
    # extra clone folders first (e.g. PRLENS_RAW_DIRS=~/rawts:~/rawcs, where git is faster than a shared folder)
    *[Path(p).expanduser() for p in os.getenv("PRLENS_RAW_DIRS", "").split(":") if p],
    ROOT / "data" / "raw",
    Path("~/raw2").expanduser(),
]


def git_show(repo: Path, spec: str) -> str | None:
    r = subprocess.run(["git", "show", spec], cwd=repo, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def find_repo(name: str, raw_dirs=None) -> Path | None:
    for d in raw_dirs or DEFAULT_RAW:
        d = Path(d).expanduser()
        if (d / name / ".git").exists():
            return d / name
    return None


def load_index(path: Path = INDEX) -> dict[str, dict]:
    return {r["bug_id"]: r for r in (json.loads(l) for l in open(path)) if r}
