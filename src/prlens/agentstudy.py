"""The agent study: can PR Lens triage agent-written PRs? The Muse Code agent re-implements evaluation PRs.

    prlens agent-study prepare     # clean snapshots + prompts for the chosen tasks (no model calls)
    prlens agent-study validate    # run the fix's tests on the original PR, the agent's change and the parent
    prlens agent-study triage --plan-only   # then --yes: score the judged agent PRs with Spark Open

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
import time
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
change focused; do not refactor unrelated code.

About this environment: the sandbox has no network access, so dependencies may not install and the build or the
tests may not run here. That is expected. If they cannot run, do not try to work around it: do not edit build or
tool configuration (global.json, package manifests, lock files, CI files) and do not install anything. Finish the
change by reading the code carefully instead.
"""
# Files an agent may touch only to fight the sandbox; dropped from its change before validation (and counted).
ENV_FILES = re.compile(r"(^|/)(global\.json|nuget\.config|NuGet\.Config|Directory\.Build\.(props|targets)|"
                       r"package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|"
                       r"pyproject\.toml|setup\.cfg|setup\.py|requirements[^/]*\.txt|tox\.ini|uv\.lock|"
                       r"\.github/.*|\.gitignore)$")


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
        # drop commit trailers and squash-merge separators: they are not part of the task
        msg = "\n".join(l for l in msg.splitlines()
                        if not re.match(r"\s*(co-authored-by|signed-off-by|reviewed-by|change-id):", l, re.I)
                        and not re.fullmatch(r"\s*-{5,}\s*", l)).strip()
        msg = re.sub(r"\n{3,}", "\n\n", msg)
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


# ---------------------------------------------------------------- validate: the fix's tests on each agent change

VALIDATION = STUDY / "validation.jsonl"
ARTEFACT = re.compile(r"(^|/)(__pycache__|\.pytest_cache|node_modules|bin|obj|dist|build|\.venv|coverage)/|\.(pyc|dll|pdb)$")
REPO_LISTS = {"python": "repos_all.txt", "typescript": "typescript.txt", "csharp": "csharp.txt"}


def split_diff(text: str) -> list[tuple[str, str]]:
    """(path, block) for each file in a git diff."""
    out = []
    for block in re.split(r"(?m)^(?=diff --git )", text):
        m = re.match(r"diff --git a/(\S+) b/(\S+)", block)
        if m:
            out.append((m.group(2), block))
    return out


def fix_tests(fixes: list[str]) -> list[tuple[str, str]]:
    """(fix sha, test file) for every fix of the task, from the bug index."""
    index = {json.loads(l)["sha"]: json.loads(l) for l in open(ROOT / "data" / "bug_fixes.jsonl")}
    return [(sha, t) for sha in fixes for t in index[sha]["test_files"]]


def touched_python_tests(clone: Path, sha: str, path: str) -> list[str]:
    """pytest node ids of the test functions the fix added or changed in `path` (the tests that pin the bug)."""
    import ast
    diff = git(clone, "diff", "-U0", f"{sha}^", sha, "--", path)
    added = set()
    for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", diff, re.M):
        start, n = int(m.group(1)), int(m.group(2) or 1)
        added.update(range(start, start + max(n, 1)))
    try:
        tree = ast.parse(git(clone, "show", f"{sha}:{path}"))
    except SyntaxError:
        return []
    ids = []
    for node in tree.body:
        funcs = [(None, node)] if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) else (
            [(node.name, f) for f in node.body if isinstance(f, (ast.FunctionDef, ast.AsyncFunctionDef))]
            if isinstance(node, ast.ClassDef) else [])
        for cls, f in funcs:
            if f.name.startswith("test") and added & set(range(f.lineno, (f.end_lineno or f.lineno) + 1)):
                ids.append(f"{path}::{cls}::{f.name}" if cls else f"{path}::{f.name}")
    return ids


def added_lines(clone: Path, sha: str, path: str) -> set[int]:
    diff = git(clone, "diff", "-U0", f"{sha}^", sha, "--", path)
    out = set()
    for m in re.finditer(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", diff, re.M):
        start, n = int(m.group(1)), int(m.group(2) or 1)
        out.update(range(start, start + max(n, 1)))
    return out


TS_TEST_RE = re.compile(r"""^\s*(?:it|test)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1""")
CS_TEST_RE = re.compile(r"^\s*public\s+(?:async\s+)?(?:void|Task)\s+(\w+)\s*\(")


def touched_titles(clone: Path, sha: str, path: str, pattern: re.Pattern, group: int) -> list[str]:
    """Names of the tests (TypeScript it/test titles, C# test methods) enclosing lines the fix added."""
    lines = git(clone, "show", f"{sha}:{path}").splitlines()
    names = []
    for n in sorted(added_lines(clone, sha, path)):
        for i in range(min(n, len(lines)) - 1, -1, -1):
            m = pattern.match(lines[i])
            if m:
                name = re.sub(r"\\(.)", r"\1", m.group(group))  # the title as the runner sees it: \` -> `
                if name not in names:
                    names.append(name)
                break
    return names


def overlay(clone: Path, d: Path, tests: list[tuple[str, str]]) -> list[tuple[str, str, str]]:
    """Write the fix's test files into checkout `d`; (fix sha, path in the fix, path written). When the repository
    moved its tests after this commit, the file goes where the one file of the same name lives now."""
    placed = []
    for sha, t in tests:
        target = t
        if not (d / t).parent.exists():
            same = [p for p in d.rglob(Path(t).name) if "node_modules" not in p.parts]
            if len(same) == 1:
                target = same[0].relative_to(d).as_posix()
        dest = d / target
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(subprocess.run(["git", "-C", str(clone), "show", f"{sha}:{t}"], capture_output=True,
                                        check=True).stdout)
        placed.append((sha, t, target))
    return placed


def apply(d: Path, diff: str) -> str | None:
    if not diff.strip():
        return None
    patch = d.parent / f".{d.name}.agent.patch"
    patch.write_text(diff)
    r = subprocess.run(["git", "-C", str(d), "apply", "--whitespace=nowarn", str(patch)], capture_output=True, text=True)
    patch.unlink(missing_ok=True)
    return None if r.returncode == 0 else (r.stderr or "git apply failed")[-300:]


def run_python(clone: Path, rev: str, diff: str | None, tests, install: str) -> tuple[int, int, int, str]:
    from .validate import q, sh
    with tempfile.TemporaryDirectory(prefix="prlens-agent-") as tmp:
        wt = Path(tmp) / "wt"
        subprocess.run(["git", "-C", str(clone), "worktree", "add", "--detach", "-q", str(wt), rev], check=True,
                       capture_output=True)
        try:
            if diff is not None:
                err = apply(wt, diff)
                if err:
                    return -1, 0, 0, f"apply failed: {err}"
            placed = overlay(clone, wt, tests)
            uvpip = "uv pip install -q --python .venv/bin/python"
            # old commits: today's tools may refuse them, so fall back the same way for control and agent alike
            attempts = [install, install.replace("-e .", ".")]
            r = None
            for cmd in dict.fromkeys(attempts):
                r = sh(f"rm -rf .venv && uv venv -q .venv && {cmd.replace('pip install', uvpip)}", wt, timeout=900)
                if r.returncode == 0:
                    break
            if r.returncode != 0:
                return 0, 0, 1, f"install failed: {(r.stderr or r.stdout)[-300:]}"
            # only the tests the fix added or changed: the rest of a later test file may test later features
            ids = [i.replace(t, target, 1) for sha, t, target in placed for i in touched_python_tests(clone, sha, t)]
            files = " ".join(q(i) for i in ids) if ids else " ".join(q(target) for _, _, target in placed)
            text, rc = "", 0
            for pin in (None, "pytest<7", "pytest<5"):
                if pin:
                    sh(f'{uvpip} "{pin}"', wt, timeout=300)
                r = sh(f".venv/bin/python -m pytest -q -p no:cacheprovider {files}", wt, timeout=900)
                text, rc = r.stdout + r.stderr, r.returncode
                if not re.search(r"PluginValidationError|hookimpl|unexpected keyword argument|"
                                 r"PytestRemovedIn|has no attribute 'Function'|ImportError while loading conftest", text):
                    break
            passed = sum(int(x) for x in re.findall(r"(\d+) passed", text[-600:]))
            failed = sum(int(x) for x in re.findall(r"(\d+) failed", text[-600:]))
            if rc in (0, 1) and (passed or failed):
                return passed, failed, 0, text[-1500:]
            return passed, failed, 1, text[-1500:]  # 2: collection error, 4/5: usage / no tests
        finally:
            subprocess.run(["git", "-C", str(clone), "worktree", "remove", "--force", str(wt)], capture_output=True)


def run_copy(task: dict, wc, rev: str, diff: str | None, tests, row: list[str]) -> tuple[int, int, int, str]:
    from .validate import node_install_cmd, pin_sdk, run_fix_tests, sh
    wc.checkout(rev)
    d = wc.dir
    if diff is not None:
        err = apply(d, diff)
        if err:
            return -1, 0, 0, f"apply failed: {err}"
    placed = overlay(wc.repo, d, tests)
    lang = task["language"]
    install = row[1] if len(row) > 1 and row[1] else (node_install_cmd(d) if lang == "typescript" else "true")
    lh = wc.lock_hash()
    if wc.installed_for != lh:
        r = sh(install, d, timeout=1800)
        if r.returncode != 0:
            return 0, 0, 1, f"install failed: {(r.stderr or r.stdout)[-300:]}"
        wc.installed_for = lh
    if lang == "csharp":
        pin_sdk(d)
    files = list(dict.fromkeys(target for _, _, target in placed))
    if lang == "typescript" and not (len(row) > 2 and row[2]):
        # only the tests the fix added or changed, by title (-t works for vitest and jest)
        from .validate import node_test_cmd, q, read_report
        passed = failed = broken = 0
        out = ""
        for i, f in enumerate(files):
            titles = [x for sha, t, target in placed if target == f for x in touched_titles(wc.repo, sha, t, TS_TEST_RE, 2)]
            report = d.parent / f".{d.name}-agent-{i}.json"
            report.unlink(missing_ok=True)
            cmd = node_test_cmd(d, f, report)
            if titles:
                cmd += " -t " + q("|".join(re.escape(x) for x in titles))
            r = sh(cmd, d)
            p_, f_, b_ = read_report(report)
            if (p_, f_, b_) == (0, 0, 0) and r.returncode != 0:
                b_ = 1
            passed, failed, broken, out = passed + p_, failed + f_, broken + b_, out + (r.stdout + r.stderr)[-1500:]
            report.unlink(missing_ok=True)
        return passed, failed, broken, out
    if lang == "csharp" and not (len(row) > 2 and row[2]):
        # only the test methods the fix added or changed
        from .validate import dotnet_test_cmd
        methods = [x for sha, t, _ in placed for x in touched_titles(wc.repo, sha, t, CS_TEST_RE, 1)]
        if methods:
            import prlens.validate as V
            orig = V.dotnet_test_cmd

            def narrowed(dd, test):
                cmd = orig(dd, test)
                if not cmd:
                    return cmd
                cls = Path(test).stem
                if "--filter-class" in cmd:
                    return re.sub(r"--filter-class '\*[^']*'", " ".join(f"--filter-method '*{cls}.{m}'" for m in methods), cmd)
                return re.sub(r'--filter "FullyQualifiedName~[^"]*"',
                              '--filter "' + "|".join(f"FullyQualifiedName~{cls}.{m}" for m in methods) + '"', cmd)
            V.dotnet_test_cmd = narrowed
            try:
                return run_fix_tests(lang, d, files, row, "agent")
            finally:
                V.dotnet_test_cmd = orig
    return run_fix_tests(lang, d, files, row, "agent")


def verdict(control: tuple, agent: tuple) -> str:
    cp, cf, cb, _ = control
    ap, af, ab, _ = agent
    if cb or not cf:
        return "not_judgeable"      # the fix's tests do not load, or do not catch the original bug, at this point
    if ap == -1:
        return "apply_failed"
    if ab:
        return "api_mismatch"       # the agent's API differs from what the tests call: leaves the study
    return "bug" if af else "no_bug"


def validate(args) -> None:
    from .mine import repo_lines
    from .validate import WorkingCopy
    tasks = [json.loads(l) for l in open(STUDY / "tasks.jsonl")]
    if args.only:
        tasks = [t for t in tasks if t["task"] in args.only]
    done = {}
    if VALIDATION.exists():
        done = {json.loads(l)["task"]: json.loads(l) for l in VALIDATION.read_text().splitlines() if l.strip()}
    index = {json.loads(l)["sha"]: json.loads(l) for l in open(ROOT / "data" / "bug_fixes.jsonl")}
    copies: dict[str, WorkingCopy] = {}
    for t in tasks:
        if t["task"] in done and not args.redo:
            continue
        name = t["task"].replace("@", "__")
        res = STUDY / "results" / f"{name}.diff"
        if not res.exists():
            print(f"{t['task']}: no agent result yet", flush=True)
            continue
        kept, dropped = [], []
        for path, block in split_diff(res.read_text()):
            if ARTEFACT.search(path):
                continue  # build output the agent's tools left behind, not part of its change
            (dropped if ENV_FILES.search(path) else kept).append((path, block))
        diff = "".join(b for _, b in kept)
        clone = find_repo(t["repo"])
        url = index[t["fixes"][0]]["repo_url"]
        rows = {r[0]: r for r in repo_lines(str(ROOT / "data" / "repos" / REPO_LISTS[t["language"]]))}
        row = rows.get(url) or rows.get(url.removesuffix(".git")) or [url]
        tests = fix_tests(t["fixes"])
        t0 = time.time()
        try:
            if t["language"] == "python":
                install = row[1] if len(row) > 1 and row[1] else "pip install -e . pytest"
                control = run_python(clone, t["pr_sha"], None, tests, install)
                agent = run_python(clone, t["parent"], diff, tests, install)
                base = run_python(clone, t["parent"], None, tests, install)
            else:
                wc = copies.setdefault(t["repo"], WorkingCopy(clone, ROOT / "data" / "work" / "validate"))
                control = run_copy(t, wc, t["pr_sha"], None, tests, row)
                agent = run_copy(t, wc, t["parent"], diff, tests, row)
                base = run_copy(t, wc, t["parent"], None, tests, row)
        except (subprocess.TimeoutExpired, RuntimeError, subprocess.CalledProcessError) as e:
            print(f"{t['task']}: could not run ({type(e).__name__}: {str(e)[:150]})", flush=True)
            continue
        v = verdict(control, agent)
        # a confirmed bug is an omission when the untouched parent loads and fails the same tests too (the change left
        # out behaviour the later fix required); otherwise the failure is in code the change itself wrote
        failing = lambda r: sorted(set(re.findall(r"^FAILED (\S+)", r[3], re.M)))  # noqa: E731 (pytest only)
        kind = None
        if v == "bug":
            fa, fb = set(failing(agent)), set(failing(base))
            if fa:   # per test: every test the agent fails also fails, and loads, on the untouched parent
                omission = not base[2] and fa <= fb
            else:    # counts only (TypeScript, C#)
                omission = not base[2] and base[1] >= agent[1]
            kind = "omission" if omission else "new-code bug"
        rec = {"task": t["task"], "language": t["language"], "verdict": v,
               "control": {"passed": control[0], "failed": control[1], "not_loading": control[2]},
               "agent": {"passed": agent[0], "failed": agent[1], "not_loading": agent[2]},
               "parent": {"passed": base[0], "failed": base[1], "not_loading": base[2]}, "bug_kind": kind,
               "failing": {"control": failing(control), "agent": failing(agent), "parent": failing(base)},
               "agent_files": [p for p, _ in kept], "env_files_dropped": [p for p, _ in dropped],
               "test_files": [x for _, x in tests], "agent_output_tail": " ".join(agent[3].split())[-400:],
               "seconds": round(time.time() - t0)}
        done[t["task"]] = rec
        VALIDATION.write_text("".join(json.dumps(r) + "\n" for r in done.values()))
        print(f"{t['task']:32s} {v:14s} {kind or '':10s} control {control[:3]}  agent {agent[:3]}  parent {base[:3]}"
              + (f"  (dropped {', '.join(p for p, _ in dropped)})" if dropped else "") + f"  {rec['seconds']}s", flush=True)
    c = {}
    for r in done.values():
        c[r["verdict"]] = c.get(r["verdict"], 0) + 1
    print("verdicts:", c)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="step", required=True)
    sub.add_parser("prepare")
    v = sub.add_parser("validate", help="run each fix's tests on the original PR (control) and on the agent's change")
    v.add_argument("--only", nargs="*", help="task ids (e.g. zod@b63db248ab)")
    v.add_argument("--redo", action="store_true")
    tr = sub.add_parser("triage", help="score the judged agent PRs with PR Lens and save data/triage_agent.json")
    tr.add_argument("--model", default="spark_open")
    tr.add_argument("--workers", type=int, default=4)
    tr.add_argument("--yes", action="store_true")
    tr.add_argument("--plan-only", action="store_true")
    tr.add_argument("--rebuild", action="store_true", help="rebuild the PRs from the agent diffs (needs the clones)")
    args = ap.parse_args(argv)
    {"prepare": prepare, "validate": validate, "triage": triage}[args.step](args)


# ---------------------------------------------------------------- triage the agent's PRs with PR Lens

LABELS = STUDY / "labels.json"
PRS_BUILT = STUDY / "prs.jsonl"
OUT_TRIAGE = ROOT / "data" / "triage_agent.json"
AGENT = "Muse Code"
AGENT_MODEL = "muse-spark-1.3-contributor"


def agent_pr(t: dict, val: dict, fix_index: dict) -> dict:
    """The agent's change as a PR in the shape live triage scores (environment edits and build output dropped)."""
    from .live import hunks_from_diff
    name = t["task"].replace("@", "__")
    kept = [b for p, b in split_diff((STUDY / "results" / f"{name}.diff").read_text())
            if not ARTEFACT.search(p) and not ENV_FILES.search(p)]
    clone = find_repo(t["repo"]) or ROOT / "data" / "work" / "validate" / t["repo"]

    def old_source(path: str) -> str | None:
        r = subprocess.run(["git", "-C", str(clone), "show", f"{t['parent']}:{path}"], capture_output=True, text=True)
        return r.stdout if r.returncode == 0 else None

    hunks = hunks_from_diff("".join(kept), old_source)
    msg = git(clone, "log", "-1", "--format=%B", t["pr_sha"]).strip()
    msg = TAG_RE.sub("", msg)
    url = fix_index[t["fixes"][0]]["repo_url"].removesuffix(".git")
    full = "/".join(url.rstrip("/").split("/")[-2:])
    date = git(clone, "log", "-1", "--format=%cI", t["pr_sha"]).strip()
    return {"pr_id": f"agent:{full}@{t['pr_sha'][:10]}", "repo": full, "sha": t["pr_sha"], "subject": msg.split("\n")[0],
            "message": msg, "author": AGENT, "date": date, "language": t["language"], "bugs": [], "hunks": hunks,
            "lines": sum(h["added"] + h["removed"] for h in hunks)}


def label(pr: dict, labels: list[dict]) -> list[str]:
    """Mark the region holding each labelled line as the bug; returns the region ids (a hunk id if it was skipped)."""
    ids = []
    for lb in labels:
        hit = None
        for h in pr["hunks"]:
            if h["file"] != lb["file"]:
                continue
            for g in h["regions"]:
                if lb["line"] in g["new_lines"]:
                    hit = (h, g)
            if hit is None and h["new_start"] <= lb["line"] < h["new_start"] + max(1, h["new_len"]):
                # a context line: the nearest region of that hunk
                g = min(h["regions"], key=lambda g: min((abs(n - lb["line"]) for n in g["new_lines"]), default=10**9))
                hit = (h, g)
        if hit is None:
            raise SystemExit(f"{pr['pr_id']}: no region of {lb['file']} holds line {lb['line']}")
        h, g = hit
        g["bug"] = True
        h["bug"] = True
        ids.append(h["id"] if h["skip"] else g["id"])
    return ids


def not_judgeable_why(v: dict | None) -> str:
    """Why a task left the study, in a few words."""
    if not v:
        return "not validated (no result)"
    c, a = v["control"], v["agent"]
    if c["not_loading"] or a["not_loading"]:
        tail = v.get("agent_output_tail", "")
        if "install failed" in tail or "Poetry" in tail or "Build failures" in tail:
            return "the project at that commit no longer installs"
        if "npm/_logs" in tail:
            return "its dependencies no longer install"
        if "0 matches" in tail:
            return "the fix's test files do not exist at that commit's layout"
        if "TargetFramework=net" in tail:
            return "the C# test project does not build at that commit"
        return "the fix's tests do not load (API mismatch)"
    if c["failed"] == 0:
        return "the original PR passes the fix's tests here, so they cannot judge the change"
    return v["verdict"].replace("_", " ")


def triage(args) -> None:
    """Score each judged agent PR with Spark Open, apply the language's combiner and threshold, and save the set
    (data/triage_agent.json) with the hand-labelled bug regions as ground truth and the study's funnel."""
    import hashlib
    import os
    import statistics
    from concurrent.futures import ThreadPoolExecutor
    from datetime import datetime, timezone

    from .export import build
    from .fit import combiner_path
    from .live import CACHE_DIR, combine, to_score
    from .llm import confirm, plan_line, spec
    from .score import prompt_for, score_region

    tasks = {json.loads(l)["task"]: json.loads(l) for l in open(STUDY / "tasks.jsonl")}
    val = {json.loads(l)["task"]: json.loads(l) for l in VALIDATION.read_text().splitlines() if l.strip()}
    labels = json.loads(LABELS.read_text())
    fix_index = {json.loads(l)["sha"]: json.loads(l) for l in open(ROOT / "data" / "bug_fixes.jsonl")}
    judged = [n for n in TASKS if val.get(n, {}).get("verdict") in ("bug", "no_bug")]
    missing = [n for n in judged if val[n]["verdict"] == "bug" and n not in labels]
    if missing:
        raise SystemExit(f"label these bugs first in {LABELS.relative_to(ROOT)}: {', '.join(missing)}")
    s = spec(args.model)
    # the PRs are built once where the clones are (some live outside the shared folder) and kept, so scoring can run
    # on any machine with the repository checked out
    built = {}
    if PRS_BUILT.exists():
        built = {json.loads(l)["task"]: json.loads(l)["pr"] for l in PRS_BUILT.read_text().splitlines() if l.strip()}
    if args.rebuild or any(n not in built for n in judged):
        built.update({n: agent_pr(tasks[n], val[n], fix_index) for n in judged if args.rebuild or n not in built})
        PRS_BUILT.write_text("".join(json.dumps({"task": n, "pr": built[n]}) + "\n" for n in judged))
    prs = {n: json.loads(json.dumps(built[n])) for n in judged}
    cache_path = CACHE_DIR / f"agent_study__{args.model}.jsonl"
    cache = {}
    if cache_path.exists():
        cache = {json.loads(l)["key"]: json.loads(l) for l in cache_path.read_text().splitlines() if l.strip()}
    key = lambda pr, hg: f"{pr['pr_id']}|{hg[1]['id']}|{hashlib.sha1(prompt_for(pr, *hg).encode()).hexdigest()[:16]}"  # noqa: E731
    jobs = [(pr, hg) for pr in prs.values() for hg in to_score(pr)]
    fresh = [(pr, hg) for pr, hg in jobs if key(pr, hg) not in cache or cache[key(pr, hg)].get("error")]
    avg_in = int(statistics.mean(len(prompt_for(pr, *hg)) for pr, hg in fresh) / 4) if fresh else 0
    os.environ.setdefault("PLAN_INPUT_TOKENS", str(avg_in))
    line, _ = plan_line(s, len(fresh), 450)
    confirm(f"{len(prs)} Muse Code PRs ({sum(v['verdict'] == 'bug' for v in val.values())} with a confirmed bug), "
            f"{len(jobs)} regions, {len(fresh)} to score with {s.name} ({s.model_id} on {s.provider}).\n{line}",
            args.yes or not fresh, args.plan_only)
    with ThreadPoolExecutor(args.workers) as ex:
        new = dict(zip([key(pr, hg) for pr, hg in fresh], ex.map(lambda j: score_region(s, j[0], *j[1]), fresh)))
    if new:
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with open(cache_path, "a") as fh:
            for k, r in new.items():
                fh.write(json.dumps({**r, "key": k}) + "\n")
    cache.update(new)

    out, rows = [], []
    for n, pr in prs.items():
        bug_ids = label(pr, labels.get(n, [])) if val[n]["verdict"] == "bug" else []
        by_id = {hg[1]["id"]: cache.get(key(pr, hg), {}) for hg in to_score(pr)}
        language, comb, calibrated = combine(pr, by_id)
        guarantee = {"missBound": comb.get("alpha", 0.2), "confidence": 0.9,
                     "calibratedOn": f"the {language} evaluation set (human-written PRs); not calibrated on agent PRs"}
        o = build(pr, comb["threshold"], guarantee)
        o["groundTruth"]["bugItemIds"] = bug_ids
        o["groundTruth"]["caughtByTriage"] = any(i["id"] in bug_ids for i in o["toReview"])
        o["groundTruth"]["fixes"] = [{"sha": f[:10], "subject": fix_index[f].get("subject", "") if f in fix_index else "",
                                      "evidence": "labelled"} for f in tasks[n]["fixes"]]
        if not bug_ids:
            o.pop("groundTruth")  # the fix's tests pass on this change: no known bug to reveal
        o.update(source="agent", language=language, branch=f"muse/{tasks[n]['repo']}-{pr['sha'][:7]}",
                 author={"name": AGENT, "kind": "ai_agent", "agent": f"{AGENT} ({AGENT_MODEL})"},
                 panel=[s.name, "combiner", "rules"], taskSummary=pr["message"][:1500])
        out.append(o)
        read = sum(i["added"] + i["removed"] for i in o["toReview"])
        rows.append({"task": n, "prId": o["id"], "verdict": val[n]["verdict"], "bugKind": val[n].get("bug_kind"),
                     "caught": o["groundTruth"]["caughtByTriage"] if bug_ids else None, "lines": pr["lines"],
                     "read": read, "why": [lb["why"] for lb in labels.get(n, [])]})
        print(f"{n:28s} {val[n]['verdict']:7s} read {read:4d}/{pr['lines']:<4d} "
              + ("" if not bug_ids else ("bug KEPT for review" if o["groundTruth"]["caughtByTriage"] else "bug SKIPPED")))

    attempted = len(TASKS)
    patched = sum(1 for n in TASKS if (STUDY / "results" / f"{n.replace('@', '__')}.diff").exists()
                  and (STUDY / "results" / f"{n.replace('@', '__')}.diff").read_text().strip())
    bugs = [r for r in rows if r["verdict"] == "bug"]
    funnel = [
        {"stage": "Tasks given to Muse Code", "prs": attempted},
        {"stage": "Muse Code produced a change", "prs": patched},
        {"stage": "Fix tests load and the original PR fails them (judgeable)", "prs": len(rows)},
        {"stage": "A fix test fails on Muse Code's change: bug confirmed", "prs": len(bugs)},
        {"stage": "Bug kept in PR Lens's review list", "prs": sum(1 for r in bugs if r["caught"])},
    ]
    read = sum(r["read"] for r in rows)
    total = sum(r["lines"] for r in rows)
    OUT_TRIAGE.write_text(json.dumps({
        "kind": "triage", "name": "agent", "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": args.model, "threshold": json.loads(combiner_path("python").read_text())["threshold"], "alpha": 0.2,
        "summary": {"prs": len(rows), "repos": len({o["repo"] for o in out}), "missed": len(bugs) - funnel[-1]["prs"],
                    "read_share": read / max(1, total), "held_out_missed": 0, "held_out_read_share": 0,
                    "agentStudy": {"agent": AGENT, "model": AGENT_MODEL, "funnel": funnel, "tasks": rows,
                                   "notJudgeable": [{"task": n, "language": tasks[n]["language"], "why": not_judgeable_why(val.get(n))}
                                                    for n in TASKS if val.get(n, {}).get("verdict") != "bug"
                                                    and val.get(n, {}).get("verdict") != "no_bug"]}},
        "prs": out,
    }, indent=1))
    print(f"saved {OUT_TRIAGE.relative_to(ROOT)}: {funnel[-1]['prs']}/{len(bugs)} bugs kept, read {read}/{total} lines")
