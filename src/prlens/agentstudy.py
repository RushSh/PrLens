"""The agent study: can PR Lens triage agent-written PRs? The Muse Code agent re-implements evaluation PRs.

    prlens agent-study prepare     # clean snapshots + prompts for the chosen tasks (no model calls)

For each chosen evaluation PR (a commit that introduced a test-confirmed bug), the agent gets a snapshot of the
repository at that commit's PARENT, with fresh git history, so neither the commit nor its later fix can be seen,
and the commit message as the task. Its change is later checked with the fix's own tests (`validate` step):
tests that do not load mean an API mismatch (the task leaves the study); a test that loads and fails confirms a bug.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .bugdata import ROOT, find_repo

STUDY = ROOT / "data" / "agent_study"
WORK = ROOT / "data" / "work" / "agent_study"
TASKS = [
    # Python
    "boltons@89bb0a8b96", "sqlparse@7de1999a0a", "isort@cc34b2c087", "isort@59fff6c807", "sqlglot@47e255dda3",
    "packaging@e80f70f8b1", "isort@8b450398ef", "packaging@e8a06183c1", "networkx@eb0a63b37c",
    "more-itertools@eb24d3927a", "packaging@ee13ba2c1c", "mistune@8baf90bf10", "more-itertools@a50ab3eebb",
    # TypeScript
    "hono@fa8eef7079", "es-toolkit@97e4eee74a", "radashi@c378bd1bc4", "valibot@a0aa98555c", "yaml@c20a295fd5",
    "immer@8848a5b169", "zod@b63db248ab", "hono@09a81e4f01",
    # C#
    "spectre.console@8fa53f8fb1", "markdig@087e7a68b6", "spectre.console@2011cb2eff", "markdig@bc4e399087",
]
TAG_RE = re.compile(r"\s*\[(CLAUDE|COPILOT|CURSOR|AI|GPT|BOT)\]", re.I)

PROMPT = """You are working in a checkout of the {repo} repository ({language}).

Implement this change, as its author described it:

{message}

Change the library source to make it so, and add or update tests the way this project usually does. Keep the
change focused; do not refactor unrelated code. When you are done, the repository should build and its existing
tests should pass.
"""


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True).stdout


def prepare(args) -> None:
    prs = {json.loads(l)["pr_id"]: json.loads(l) for l in open(ROOT / "data" / "triage" / "prs.jsonl")}
    WORK.mkdir(parents=True, exist_ok=True)
    out = []
    for tid in TASKS:
        p = prs[tid]
        repo = find_repo(p["repo"])
        if repo is None:
            raise SystemExit(f"no clone of {p['repo']}")
        parent = git(repo, "rev-parse", f"{p['sha']}^").strip()
        dest = WORK / tid.replace("@", "__") / "repo"
        if not (dest / ".git").exists():
            if dest.exists():
                shutil.rmtree(dest)
            # git archive: the tree only, no history, so nothing after the parent is reachable. Extracted to a
            # temporary folder first and copied with symlinks resolved (some shared folders refuse symlinks).
            with tempfile.TemporaryDirectory() as tmp:
                subprocess.run(f"git -C '{repo}' archive {parent} | tar -x -C '{tmp}'", shell=True, check=True)
                shutil.copytree(tmp, dest, symlinks=False, ignore_dangling_symlinks=True)
            for cmd in (["init", "-q"], ["add", "-A"],
                        ["-c", "user.name=baseline", "-c", "user.email=baseline@local", "commit", "-q", "-m",
                         f"baseline: {p['repo']} at {parent[:10]}"]):
                subprocess.run(["git", "-C", str(dest), *cmd], check=True, capture_output=True)
        msg = TAG_RE.sub("", (p.get("message") or p["subject"]).strip())
        prompt = PROMPT.format(repo=p["repo"], language=p["language"], message=msg)
        (dest.parent / "prompt.txt").write_text(prompt)
        fixes = [b["fix_sha"] for b in p["bugs"]]
        out.append({"task": tid, "repo": p["repo"], "language": p["language"], "pr_sha": p["sha"], "parent": parent,
                    "fixes": fixes, "pr_lines": p["lines"], "dir": str(dest.relative_to(ROOT)),
                    "prompt": str((dest.parent / "prompt.txt").relative_to(ROOT))})
        print(f"{tid:32s} {p['language']:10s} {p['lines']:4d} lines  snapshot at {parent[:10]}", flush=True)
    STUDY.mkdir(parents=True, exist_ok=True)
    (STUDY / "tasks.jsonl").write_text("".join(json.dumps(t) + "\n" for t in out))
    print(f"{len(out)} tasks -> {(STUDY / 'tasks.jsonl').relative_to(ROOT)}")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="step", required=True)
    sub.add_parser("prepare")
    args = ap.parse_args(argv)
    {"prepare": prepare}[args.step](args)
