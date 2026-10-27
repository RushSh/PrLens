"""Clone every mined repository and create its test environment, once per machine.

Needed before validating decoys (scripts/decoys.py validate) or rebuilding realism units. Clones go to
data/raw/<name> (skipped if a clone already exists there or in ~/raw2), environments to data/envs/venv-<name>
(uv + Python 3.12, the project installed with its test extras, plus pytest). Safe to run again: finished
repositories are skipped. Needs git and uv.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from bugcensus.bugdata import find_repo  # noqa: E402
from realism import ensure_env  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repos", default=str(ROOT / "scripts" / "repos_all.txt"))
    ap.add_argument("--raw", default=str(ROOT / "data" / "raw"))
    ap.add_argument("--envs", default=str(ROOT / "data" / "envs"))
    ap.add_argument("--only", default="", help="comma list of repository names")
    args = ap.parse_args()

    for tool in ("git", "uv"):
        if not shutil.which(tool):
            sys.exit(f"{tool} is not installed (uv: https://docs.astral.sh/uv/)")
    raw, envs = Path(args.raw), Path(args.envs)
    raw.mkdir(parents=True, exist_ok=True)
    envs.mkdir(parents=True, exist_ok=True)
    only = {x for x in args.only.split(",") if x}
    ok, failed = [], []
    entries = [l.split("|", 1) for l in Path(args.repos).read_text().splitlines()
               if l.strip() and not l.startswith("#") and "|" in l]
    for n, (url, install) in enumerate(entries, 1):
        url, install = url.strip(), install.strip()
        name = url.rstrip("/").removesuffix(".git").split("/")[-1]
        if only and name not in only:
            continue
        repo = find_repo(name, [raw, Path("~/raw2").expanduser()])
        if not repo:
            print(f"[{n}/{len(entries)}] cloning {name} ...", flush=True)
            r = subprocess.run(["git", "clone", "-q", url, str(raw / name)], capture_output=True, text=True)
            if r.returncode:
                print(f"  clone failed: {r.stderr.strip()[-300:]}", flush=True)
                failed.append(name)
                continue
            repo = raw / name
        print(f"[{n}/{len(entries)}] test environment for {name} ...", flush=True)
        if ensure_env(repo, envs / f"venv-{name}", install):
            ok.append(name)
        else:
            failed.append(name)
    print(f"\nready: {len(ok)} ({', '.join(ok)})")
    if failed:
        print(f"failed: {len(failed)} ({', '.join(failed)}); their bugs are skipped when validating")


if __name__ == "__main__":
    main()
