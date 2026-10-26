"""Confirm each mined candidate is a real bug: the fix's tests FAIL on the pre-fix code and PASS on the fix.

For each candidate (from mine_bugs.py):
  1. make a temporary worktree at the fix commit, create a venv, run the repo's install command;
  2. run the changed test files -> must pass;
  3. check out the PARENT version of the source files only (tests stay at the fix) -> must fail.
Writes confirmed bugs to --out. Slow (one install per repo per run); run it in the background.

Usage:
  python scripts/validate_bugs.py --candidates data/candidates.jsonl --repos scripts/repos.txt --out data/bugs.jsonl
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path


def sh(cmd: str, cwd: Path, timeout: int = 900) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", default="data/candidates.jsonl")
    ap.add_argument("--repos", default="scripts/repos.txt")
    ap.add_argument("--workdir", default="data/raw")
    ap.add_argument("--out", default="data/bugs.jsonl")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    install = {}
    for raw in Path(args.repos).read_text().splitlines():
        if raw.strip() and not raw.startswith("#") and "|" in raw:
            url, cmd = (x.strip() for x in raw.split("|", 1))
            install[url] = cmd
    cands = [json.loads(l) for l in Path(args.candidates).read_text().splitlines() if l.strip()]
    if args.limit:
        cands = cands[: args.limit]
    ok = 0
    with open(args.out, "a") as out:
        for c in cands:
            repo = Path(args.workdir) / c["name"]
            tmp = Path(tempfile.mkdtemp(prefix="bugcensus-val-"))
            wt = tmp / "wt"
            try:
                sh(f"git worktree add --detach {wt} {c['sha']}", repo)
                use_uv = shutil.which("uv") is not None
                venv = "uv venv -q .venv" if use_uv else "python3 -m venv .venv"
                pip = install.get(c["repo"], "pip install -e . pytest")
                pip = pip.replace("pip install", "uv pip install -q --python .venv/bin/python" if use_uv
                                  else ".venv/bin/pip install -q")
                setup = sh(f"{venv} && {pip}", wt)
                if setup.returncode != 0:
                    print(f"SKIP install {c['name']} {c['sha'][:8]}: {setup.stderr[-200:]}")
                    continue
                tests = " ".join(c["test_files"])
                after = sh(f".venv/bin/python -m pytest -x -q {tests}", wt)
                sh(f"git checkout {c['sha']}^ -- {' '.join(c['src_files'])}", wt)
                before = sh(f".venv/bin/python -m pytest -x -q {tests}", wt)
                confirmed = after.returncode == 0 and before.returncode != 0
                print(f"{'CONFIRMED' if confirmed else 'rejected '} {c['name']} {c['sha'][:8]} {c['subject'][:60]}")
                if confirmed:
                    out.write(json.dumps(c) + "\n")
                    out.flush()
                    ok += 1
            except subprocess.TimeoutExpired:
                print(f"TIMEOUT {c['name']} {c['sha'][:8]}")
            finally:
                sh(f"git worktree remove --force {wt}", repo)
                shutil.rmtree(tmp, ignore_errors=True)
    print(f"{ok} confirmed bugs -> {args.out}")


if __name__ == "__main__":
    main()
