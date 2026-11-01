"""The closed loop: PR Lens flags regions, Muse Spark asks what to check, the Muse Code agent suggests a fix, and the
later fix's own tests judge the suggestion.

    prlens suggest prepare        # a workspace per agent-study PR whose bug PR Lens kept for review (no model calls)
    bash data/agent_study/run_suggest.sh      # on the Mac: Muse Code proposes a fix in each workspace
    prlens suggest validate       # run the later fix's tests on the agent change + the suggestion
    prlens agent-study triage --yes && prlens explain data/triage_agent.json --yes   # attach to the dashboard

Muse Code sees only what a reviewer sees in PR Lens: the task, its own change, and the flagged regions with their
Muse Spark notes and questions. It never sees the bug label, the later fix or its tests. A suggestion is shown as
"suggested, still needs human review", with the test result next to it.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import time
from pathlib import Path

from .agentstudy import (ARTEFACT, ENV_FILES, REPO_LISTS, STUDY, TASKS, VALIDATION, WORK, find_repo, fix_tests,
                         run_copy, run_python, split_diff)
from .bugdata import ROOT

SUGGEST_WORK = ROOT / "data" / "work" / "suggest"
RESULTS = STUDY / "suggest"
OUT = STUDY / "suggestions.jsonl"

PROMPT = """You are working in a checkout of the {repo} repository ({language}). The last commit is a change written
for this task:

{message}

A reviewer is looking at that change in PR Lens. PR Lens flagged these regions as needing a human, with what to check:

{regions}

Make the smallest change to the library source so that the reviewer could answer "yes" to every question above. Fix
only real problems in the flagged regions; if a region is already right, leave it alone. You may add or adjust tests
for the behaviour you fix. Do not refactor, and do not undo the task.

About this environment: the sandbox has no network access, so dependencies may not install and the tests may not run
here. That is expected. Do not edit build or tool configuration and do not install anything; reason from the code.
"""


def kept_bug_tasks() -> list[str]:
    """Agent-study PRs with a confirmed bug that PR Lens kept for review (the loop starts from a flagged region)."""
    d = json.loads((ROOT / "data" / "triage_agent.json").read_text())
    rows = d["summary"]["agentStudy"]["tasks"]
    return [r["task"] for r in rows if r["verdict"] == "bug" and r["caught"]]


def regions_text(pr: dict) -> str:
    out = []
    for i, it in enumerate([i for i in pr["toReview"] if not i.get("sameEdit") or i["sameEdit"]["group"] == i["id"]], 1):
        line = next((l["newNo"] for l in it["diff"] if l.get("flagged") and l["newNo"]), None)
        why = it["note"]["text"] if it.get("note") else "; ".join(r["detail"] for r in it["reasons"])
        qs = "".join(f"\n   - {q}" for q in (it.get("note") or {}).get("questions", []))
        out.append(f"{i}. {it['file']}{f':{line}' if line else ''}: {why}{qs}")
    return "\n".join(out)


def prepare(args) -> None:
    tasks = {json.loads(l)["task"]: json.loads(l) for l in open(STUDY / "tasks.jsonl")}
    prs = {p["id"]: p for p in json.loads((ROOT / "data" / "triage_agent.json").read_text())["prs"]}
    rows = {r["task"]: r for r in json.loads((ROOT / "data" / "triage_agent.json").read_text())["summary"]["agentStudy"]["tasks"]}
    names = args.only or kept_bug_tasks()
    for n in names:
        t, pr = tasks[n], prs[rows[n]["prId"]]
        if not any(i.get("note") for i in pr["toReview"]):
            raise SystemExit(f"{n}: no Muse Spark notes yet; run prlens explain data/triage_agent.json first")
        name = n.replace("@", "__")
        dest = SUGGEST_WORK / name / "repo"
        if dest.exists():
            shutil.rmtree(dest.parent)
        shutil.copytree(WORK / name / "repo", dest, symlinks=False)
        diff = "".join(b for p, b in split_diff((STUDY / "results" / f"{name}.diff").read_text())
                       if not ARTEFACT.search(p) and not ENV_FILES.search(p))
        patch = dest.parent / "agent.patch"
        patch.write_text(diff)
        subprocess.run(["git", "-C", str(dest), "apply", "--whitespace=nowarn", str(patch)], check=True, capture_output=True)
        for cmd in (["add", "-A"], ["-c", "user.name=Muse Code", "-c", "user.email=muse@local", "commit", "-q", "-m",
                                    f"agent change: {pr['title']}"]):
            subprocess.run(["git", "-C", str(dest), *cmd], check=True, capture_output=True)
        (dest.parent / "prompt.txt").write_text(PROMPT.format(repo=pr["repo"], language=t["language"],
                                                              message=pr["taskSummary"], regions=regions_text(pr)))
        print(f"{n:28s} {len(pr['toReview'])} flagged regions -> {dest.parent.relative_to(ROOT)}", flush=True)


def validate(args) -> None:
    from .mine import repo_lines
    from .validate import WorkingCopy
    tasks = {json.loads(l)["task"]: json.loads(l) for l in open(STUDY / "tasks.jsonl")}
    val = {json.loads(l)["task"]: json.loads(l) for l in VALIDATION.read_text().splitlines() if l.strip()}
    index = {json.loads(l)["sha"]: json.loads(l) for l in open(ROOT / "data" / "bug_fixes.jsonl")}
    done = {json.loads(l)["task"]: json.loads(l) for l in OUT.read_text().splitlines() if l.strip()} if OUT.exists() else {}
    copies: dict = {}
    for n in args.only or kept_bug_tasks():
        name = n.replace("@", "__")
        res = RESULTS / f"{name}.combined.diff"
        if not res.exists():
            print(f"{n}: no suggestion yet", flush=True)
            continue
        if n in done and not args.redo:
            continue
        t = tasks[n]
        combined = "".join(b for p, b in split_diff(res.read_text()) if not ARTEFACT.search(p) and not ENV_FILES.search(p))
        clone = find_repo(t["repo"]) or ROOT / "data" / "work" / "validate" / t["repo"]
        url = index[t["fixes"][0]]["repo_url"]
        rows = {r[0]: r for r in repo_lines(str(ROOT / "data" / "repos" / REPO_LISTS[t["language"]]))}
        row = rows.get(url) or rows.get(url.removesuffix(".git")) or [url]
        tests = fix_tests(t["fixes"])
        t0 = time.time()
        if t["language"] == "python":
            install = row[1] if len(row) > 1 and row[1] else "pip install -e . pytest"
            r = run_python(clone, t["parent"], combined, tests, install)
        else:
            wc = copies.setdefault(t["repo"], WorkingCopy(clone, ROOT / "data" / "work" / "validate"))
            r = run_copy(t, wc, t["parent"], combined, tests, row)
        before = val[n]["agent"]
        status = ("apply_failed" if r[0] == -1 else "not_loading" if r[2] else
                  "fixed" if r[1] == 0 and r[0] > 0 else "partly fixed" if r[1] < before["failed"] else "not fixed")
        suggestion = (RESULTS / f"{name}.diff").read_text() if (RESULTS / f"{name}.diff").exists() else ""
        done[n] = {"task": n, "status": status, "tests": {"passed": r[0], "failed": r[1], "not_loading": r[2]},
                   "before": before, "suggestion_lines": sum(1 for l in suggestion.splitlines()
                                                             if l[:1] in "+-" and l[:3] not in ("+++", "---")),
                   "seconds": round(time.time() - t0), "output_tail": " ".join(r[3].split())[-300:]}
        OUT.write_text("".join(json.dumps(v) + "\n" for v in done.values()))
        print(f"{n:28s} {status:13s} fix tests {r[0]} passed / {r[1]} failed (agent change alone: "
              f"{before['passed']} / {before['failed']})", flush=True)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="step", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--only", nargs="*")
    v = sub.add_parser("validate")
    v.add_argument("--only", nargs="*")
    v.add_argument("--redo", action="store_true")
    args = ap.parse_args(argv)
    {"prepare": prepare, "validate": validate}[args.step](args)


if __name__ == "__main__":
    main()
