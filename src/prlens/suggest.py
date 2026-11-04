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

# The control: the same task and change, without PR Lens's flagged regions, notes or questions. Comparing the two
# on the same PRs is what says whether the flags helped.
PROMPT_BLIND = """You are working in a checkout of the {repo} repository ({language}). The last commit is a change written
for this task:

{message}

A reviewer is looking at that change. Make the smallest change to the library source that fixes any real problem in
it. If the change is already right, leave it alone. You may add or adjust tests for the behaviour you fix. Do not
refactor, and do not undo the task.

About this environment: the sandbox has no network access, so dependencies may not install and the tests may not run
here. That is expected. Do not edit build or tool configuration and do not install anything; reason from the code.
"""
# Round 2 (Nov 1): both arms softened the same way, so the flags stay the only difference. Round 1's "if it is
# already right, leave it alone" mostly produced no change at all. Round 2's flagged prompt also carries the version-2
# Muse Spark notes (whole PR as context, boundary-input checklist).
_SOFT_TAIL = """
Assume the reviewer suspects a real bug that the task's own tests would not catch. Find it and fix it with the
smallest change to the library source; if, after checking carefully, you find no bug at all, leave the code as it is.
You may add tests for the behaviour you fix. Do not refactor, and do not undo the task.

About this environment: the sandbox has no network access, so dependencies may not install and the tests may not run
here. That is expected. Do not edit build or tool configuration and do not install anything; reason from the code.
"""
PROMPT2 = """You are working in a checkout of the {repo} repository ({language}). The last commit is a change written
for this task:

{message}

A reviewer is looking at that change in PR Lens. PR Lens flagged these regions as needing a human, with notes on what
to check. Treat them as leads, not a diagnosis: the bug may involve inputs the notes do not name.

{regions}
""" + _SOFT_TAIL
PROMPT_BLIND2 = """You are working in a checkout of the {repo} repository ({language}). The last commit is a change written
for this task:

{message}
""" + _SOFT_TAIL
VARIANTS = {"flagged": ("", PROMPT), "blind": ("__blind", PROMPT_BLIND),
            "flagged2": ("__r2", PROMPT2), "blind2": ("__r2blind", PROMPT_BLIND2)}
DEFAULT_VARIANTS = ["flagged2", "blind2"]


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
        for variant in args.variants:
            suffix, template = VARIANTS[variant]
            name = n.replace("@", "__") + suffix
            dest = SUGGEST_WORK / name / "repo"
            if (RESULTS / f"{name}.diff").exists():
                continue  # already run: keep its workspace as it was
            if dest.exists():
                shutil.rmtree(dest.parent)
            shutil.copytree(WORK / n.replace("@", "__") / "repo", dest, symlinks=False)
            diff = "".join(b for p_, b in split_diff((STUDY / "results" / f"{n.replace('@', '__')}.diff").read_text())
                           if not ARTEFACT.search(p_) and not ENV_FILES.search(p_))
            patch = dest.parent / "agent.patch"
            patch.write_text(diff)
            subprocess.run(["git", "-C", str(dest), "apply", "--whitespace=nowarn", str(patch)], check=True,
                           capture_output=True)
            for cmd in (["add", "-A"], ["-c", "user.name=Muse Code", "-c", "user.email=muse@local", "commit", "-q",
                                        "-m", f"agent change: {pr['title']}"]):
                subprocess.run(["git", "-C", str(dest), *cmd], check=True, capture_output=True)
            (dest.parent / "prompt.txt").write_text(template.format(repo=pr["repo"], language=t["language"],
                                                                    message=pr["taskSummary"], regions=regions_text(pr)))
        print(f"{n:28s} {len(pr['toReview'])} flagged regions; prepared {', '.join(args.variants)}", flush=True)


def suite_failures(clone: Path, rev: str, diff: str, install: str) -> tuple[int, set[str], str]:
    """The project's own test suite at `rev` + `diff` (no later tests overlaid): (passed, failed test ids, note).
    Run once on the agent's change and once with the suggestion: a test that passed before and fails after is a
    regression the suggestion caused."""
    import re
    import tempfile

    from .agentstudy import apply
    from .validate import sh
    with tempfile.TemporaryDirectory(prefix="prlens-suite-") as tmp:
        wt = Path(tmp) / "wt"
        subprocess.run(["git", "-C", str(clone), "worktree", "add", "--detach", "-q", str(wt), rev], check=True,
                       capture_output=True)
        try:
            err = apply(wt, diff)
            if err:
                return 0, set(), f"apply failed: {err}"
            uvpip = "uv pip install -q --python .venv/bin/python"
            r = None
            for cmd in dict.fromkeys([install, install.replace("-e .", ".")]):
                r = sh(f"rm -rf .venv && uv venv -q .venv && {cmd.replace('pip install', uvpip)}", wt, timeout=900)
                if r.returncode == 0:
                    break
            if r.returncode != 0:
                return 0, set(), "install failed"
            # old commits: the same pytest fallbacks as the fix-test runs, keeping the attempt that ran the most tests;
            # a test file that cannot be collected is reported (ERROR) instead of stopping the run
            best = (0, set(), "")
            for pin in (None, "pytest<7", "pytest<5"):
                if pin:
                    sh(f'{uvpip} "{pin}"', wt, timeout=300)
                r = sh(".venv/bin/python -m pytest -q -p no:cacheprovider -rfE --continue-on-collection-errors "
                       "2>&1 | tail -600", wt, timeout=900)
                text = r.stdout + r.stderr
                passed = sum(int(x) for x in re.findall(r"(\d+) passed", text[-800:]))
                failed = set(re.findall(r"^(?:FAILED|ERROR) (\S+)", text, re.M))
                if passed > best[0]:
                    best = (passed, failed, text)
                if passed and not re.search(r"PluginValidationError|hookimpl|unexpected keyword argument|"
                                            r"PytestRemovedIn|has no attribute 'Function'|ImportError while loading "
                                            r"conftest", text):
                    break
            if not best[0]:
                return 0, set(), "the project's suite did not run here"
            return best[0], best[1], ""
        finally:
            subprocess.run(["git", "-C", str(clone), "worktree", "remove", "--force", str(wt)], capture_output=True)


def validate(args) -> None:
    from .mine import repo_lines
    from .validate import WorkingCopy
    tasks = {json.loads(l)["task"]: json.loads(l) for l in open(STUDY / "tasks.jsonl")}
    val = {json.loads(l)["task"]: json.loads(l) for l in VALIDATION.read_text().splitlines() if l.strip()}
    index = {json.loads(l)["sha"]: json.loads(l) for l in open(ROOT / "data" / "bug_fixes.jsonl")}
    done = {}
    if OUT.exists():
        done = {(json.loads(l)["task"], json.loads(l).get("variant", "flagged")): json.loads(l)
                for l in OUT.read_text().splitlines() if l.strip()}
    copies: dict = {}
    for n in args.only or kept_bug_tasks():
        for variant in args.variants:
            name = n.replace("@", "__") + VARIANTS[variant][0]
            res = RESULTS / f"{name}.combined.diff"
            if not res.exists():
                print(f"{n} {variant}: no suggestion yet", flush=True)
                continue
            if (n, variant) in done and not args.redo:
                continue
            t = tasks[n]
            keep = lambda text: "".join(b for p_, b in split_diff(text) if not ARTEFACT.search(p_) and not ENV_FILES.search(p_))  # noqa: E731
            combined = keep(res.read_text())
            suggestion = keep((RESULTS / f"{name}.diff").read_text()) if (RESULTS / f"{name}.diff").exists() else ""
            agent_only = keep((STUDY / "results" / f"{n.replace('@', '__')}.diff").read_text())
            changed = sum(1 for l in suggestion.splitlines() if l[:1] in "+-" and l[:3] not in ("+++", "---"))
            before = val[n]["agent"]
            rec = {"task": n, "variant": variant, "suggestion_lines": changed, "before": before}
            t0 = time.time()
            if not changed:
                rec.update(status="no change", tests=before)
            else:
                clone = find_repo(t["repo"]) or ROOT / "data" / "work" / "validate" / t["repo"]
                url = index[t["fixes"][0]]["repo_url"]
                rows = {r[0]: r for r in repo_lines(str(ROOT / "data" / "repos" / REPO_LISTS[t["language"]]))}
                row = rows.get(url) or rows.get(url.removesuffix(".git")) or [url]
                tests = fix_tests(t["fixes"])
                if t["language"] == "python":
                    install = row[1] if len(row) > 1 and row[1] else "pip install -e . pytest"
                    r = run_python(clone, t["parent"], combined, tests, install)
                else:
                    wc = copies.setdefault(t["repo"], WorkingCopy(clone, ROOT / "data" / "work" / "validate"))
                    r = run_copy(t, wc, t["parent"], combined, tests, row)
                status = ("apply_failed" if r[0] == -1 else "not_loading" if r[2] else
                          "fixed" if r[1] == 0 and r[0] > 0 else "partly fixed" if r[1] < before["failed"] else "not fixed")
                rec.update(status=status, tests={"passed": r[0], "failed": r[1], "not_loading": r[2]},
                           output_tail=" ".join(r[3].split())[-300:])
                # breakage elsewhere: the project's own suite, on the agent's change and with the suggestion
                if t["language"] == "python" and not args.no_suite:
                    p0, f0, e0 = suite_failures(clone, t["parent"], agent_only, install)
                    p1, f1, e1 = suite_failures(clone, t["parent"], combined, install)
                    broke = sorted(f1 - f0)
                    # a drop in passing tests that no FAILED/ERROR line names (e.g. a module that stopped importing)
                    # counts as breakage too
                    lost = max(0, p0 - p1 - len(broke))
                    rec["suite"] = ({"checked": False, "note": e0 or e1} if e0 or e1 else
                                    {"checked": True, "passed_before": p0, "passed_after": p1, "broken": broke[:20],
                                     "broken_count": len(broke) + lost, "unnamed_drop": lost})
                else:
                    rec["suite"] = {"checked": False, "note": "suite check runs for Python only"}
            rec["seconds"] = round(time.time() - t0)
            done[(n, variant)] = rec
            OUT.write_text("".join(json.dumps(v) + "\n" for v in done.values()))
            st = rec.get("suite", {})
            print(f"{n:28s} {variant:7s} {rec['status']:13s} {changed:3d} lines; fix tests "
                  f"{rec['tests']['passed']}/{rec['tests']['failed']} (before {before['passed']}/{before['failed']})"
                  + (f"; suite: {st['broken_count']} newly failing" if st.get("checked") else
                     f"; suite not checked ({st.get('note', '')})" if st else ""), flush=True)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="step", required=True)
    p = sub.add_parser("prepare")
    p.add_argument("--only", nargs="*")
    p.add_argument("--variants", nargs="*", default=DEFAULT_VARIANTS, choices=list(VARIANTS))
    v = sub.add_parser("validate")
    v.add_argument("--only", nargs="*")
    v.add_argument("--redo", action="store_true")
    v.add_argument("--variants", nargs="*", default=DEFAULT_VARIANTS, choices=list(VARIANTS))
    v.add_argument("--no-suite", action="store_true", help="skip the regression run of the project's own tests")
    args = ap.parse_args(argv)
    {"prepare": prepare, "validate": validate}[args.step](args)


if __name__ == "__main__":
    main()
