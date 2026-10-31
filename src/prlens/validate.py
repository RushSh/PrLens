"""Confirm each mined candidate is a real bug: the fix's tests FAIL on the pre-fix code and PASS on the fix.

For each candidate (from `prlens mine`):
  1. check out the fix commit and install the project;
  2. run the changed test files -> must pass;
  3. check out the PARENT version of the source files only (tests stay at the fix) -> must fail
     (C#: and must still build: a test that no longer compiles proves an API change, not a bug).

Python: a fresh worktree and venv per candidate. TypeScript and C#: one persistent working copy per repository
(data/work/validate/<repo>), reinstalled only when the lockfile changes, so a run takes minutes per repo, not hours.
Runs on the machine with the toolchains (Node for TypeScript, the .NET SDK for C#). Resumable: candidates already
in --out (confirmed) or in <out>.rejected.jsonl are skipped.

Usage:
  prlens validate --candidates data/candidates_ts.jsonl --repos data/repos/typescript.txt --out data/bugs_ts.jsonl
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from .mine import repo_lines

TIMEOUT = 900


def sh(cmd: str, cwd: Path, timeout: int = TIMEOUT) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def q(path: str) -> str:
    return "'" + path.replace("'", "'\\''") + "'"


# ---------------------------------------------------------------- Python (unchanged behavior)


def validate_python(c: dict, repo: Path, install_cmd: str | None) -> tuple[bool | None, str]:
    tmp = Path(tempfile.mkdtemp(prefix="prlens-val-"))
    wt = tmp / "wt"
    try:
        sh(f"git worktree add --detach {wt} {c['sha']}", repo)
        use_uv = shutil.which("uv") is not None
        venv = "uv venv -q .venv" if use_uv else "python3 -m venv .venv"
        pip = install_cmd or "pip install -e . pytest"
        pip = pip.replace("pip install", "uv pip install -q --python .venv/bin/python" if use_uv else ".venv/bin/pip install -q")
        setup = sh(f"{venv} && {pip}", wt)
        if setup.returncode != 0:
            return None, f"install failed: {setup.stderr[-200:]}"
        tests = " ".join(q(t) for t in c["test_files"])
        after = sh(f".venv/bin/python -m pytest -x -q {tests}", wt)
        sh(f"git checkout {c['sha']}^ -- {' '.join(q(s) for s in c['src_files'])}", wt)
        if after.returncode != 0:
            return None, f"tests do not pass on the fix itself (pytest exit {after.returncode})"
        before = sh(f".venv/bin/python -m pytest -x -q {tests}", wt)
        if before.returncode == 1:  # tests ran and failed
            return True, "fails before, passes after"
        if before.returncode == 0:
            return False, "tests pass before the fix too"
        # exit 2: collection error (an import of something the fix added), 4/5: usage / no tests
        return False, f"tests do not run before the fix (pytest exit {before.returncode}): an API change, not a bug"
    finally:
        sh(f"git worktree remove --force {wt}", repo)
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- TypeScript and C#: one working copy per repo

LOCKFILES = ("pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", "packages.lock.json")


class WorkingCopy:
    def __init__(self, repo: Path, root: Path):
        self.repo = Path(repo).resolve()
        self.dir = Path(root).resolve() / repo.name  # absolute: git runs from inside the clone
        self.installed_for: str | None = None
        if not (self.dir / ".git").exists():
            self.dir.parent.mkdir(parents=True, exist_ok=True)
            sh(f"git worktree prune && git worktree add --detach {q(str(self.dir))} HEAD", repo)

    def checkout(self, rev: str) -> None:
        # keep installed dependencies between candidates (npm/pnpm node_modules, Yarn Plug'n'Play files, .NET builds)
        sh("git reset -q --hard && git clean -qfdx -e node_modules -e bin -e obj -e artifacts -e .pnp.cjs -e .pnp.loader.mjs "
           "-e .yarn -e .pnp.data.json", self.dir)
        r = sh(f"git checkout -q --force --detach {rev}", self.dir)
        if r.returncode != 0:
            raise RuntimeError(f"checkout {rev[:8]} failed: {r.stderr[-200:]}")

    def lock_hash(self) -> str:
        h = hashlib.sha1()
        for name in LOCKFILES:
            for p in sorted(self.dir.rglob(name)):
                if "node_modules" not in p.parts:
                    h.update(p.read_bytes())
        for p in sorted(self.dir.glob("package.json")):
            h.update(p.read_bytes())
        return h.hexdigest()


def node_install_cmd(d: Path) -> str:
    if (d / "pnpm-lock.yaml").exists():
        return ("COREPACK_ENABLE_STRICT=0 corepack pnpm install --frozen-lockfile || "
                "npx -y pnpm@9 install --frozen-lockfile --config.package-manager-strict=false")
    if (d / "yarn.lock").exists():
        return "COREPACK_ENABLE_STRICT=0 corepack yarn install --immutable || COREPACK_ENABLE_STRICT=0 corepack yarn install --frozen-lockfile"
    if (d / "bun.lock").exists() or (d / "bun.lockb").exists():
        return "bun install --frozen-lockfile || npm install --no-audit --no-fund"  # no Bun here: npm resolves the same ranges
    if (d / "package-lock.json").exists():
        return "npm ci --no-audit --no-fund"
    return "npm install --no-audit --no-fund"


def node_test_cmd(d: Path, test: str, report: Path) -> str:
    """Run one test file with the runner of the nearest package that has one (monorepos: packages/zod, library/),
    writing a JSON report: exit codes are not trusted (a config type error fails a run whose tests all pass)."""
    yarn_pnp = (d / ".pnp.cjs").exists()  # Yarn Plug'n'Play has no node_modules

    def runner(tool: str, start: Path) -> str:
        """The project's own installed runner (no npx: it refuses projects whose devEngines want another Node)."""
        if yarn_pnp:
            return f"COREPACK_ENABLE_STRICT=0 corepack yarn {tool}"
        p = start
        while True:
            b = p / "node_modules" / ".bin" / tool
            if b.exists():
                return q(str(b))
            if p == d or p == p.parent:
                return f"npx {tool}"
            p = p.parent

    p = (d / test).parent
    while True:
        pkg = p / "package.json"
        if pkg.exists():
            meta = json.loads(pkg.read_text())
            deps = {**meta.get("dependencies", {}), **meta.get("devDependencies", {})}
            rel = (d / test).relative_to(p).as_posix()
            if "vitest" in deps or (p / "vitest.config.ts").exists() or (p / "vitest.config.mts").exists():
                return f"cd {q(str(p))} && {runner('vitest', p)} run {q(rel)} --reporter=json --outputFile={q(str(report))}"
            if "jest" in deps or (p / "jest.config.js").exists() or (p / "jest.config.ts").exists():
                return f"cd {q(str(p))} && {runner('jest', p)} {q(rel)} --json --outputFile={q(str(report))}"
        if p == d or p == p.parent:
            break
        p = p.parent
    return f"{runner('vitest', d)} run {q(test)} --reporter=json --outputFile={q(str(report))}"


def read_report(report: Path) -> tuple[int, int, int]:
    """(passed, failed, files that did not load) from a vitest/jest JSON report; (0, 0, 0) when missing."""
    try:
        r = json.loads(report.read_text())
    except (OSError, ValueError):
        return 0, 0, 0
    broken = sum(1 for t in r.get("testResults", []) if t.get("status") == "failed" and not t.get("assertionResults"))
    return int(r.get("numPassedTests", 0)), int(r.get("numFailedTests", 0)), broken


_SDK_MAJOR: int | None = None


def sdk_major() -> int:
    """The newest .NET SDK installed here (e.g. 8 or 10)."""
    global _SDK_MAJOR
    if _SDK_MAJOR is None:
        out = subprocess.run("dotnet --list-sdks", shell=True, capture_output=True, text=True).stdout
        majors = [int(m) for m in re.findall(r"^(\d+)\.", out, re.M)]
        _SDK_MAJOR = max(majors) if majors else 0
    return _SDK_MAJOR


def target_framework(proj: Path, stop: Path) -> str | None:
    """The newest netN.0 the project targets that the installed SDK can build (multi-targeted test projects fail
    when any target's SDK is missing). Looks in the project, then Directory.Build.props files above it."""
    texts = [proj.read_text(errors="replace")]
    p = proj.parent
    while True:
        props = p / "Directory.Build.props"
        if props.exists():
            texts.append(props.read_text(errors="replace"))
        if p == stop or p == p.parent:
            break
        p = p.parent
    for text in texts:  # the nearest file that sets a target wins; Condition="..." variants are pooled
        found = re.findall(r"<TargetFrameworks?(?:\s[^>]*)?>([^<]+)</TargetFrameworks?>", text)
        if found:
            tfms = {t.strip() for f in found for t in f.split(";") if re.fullmatch(r"net(\d+)\.0", t.strip())}
            ok = [t for t in tfms if int(t[3:-2]) <= sdk_major()]
            return max(ok, key=lambda t: int(t[3:-2])) if ok else None
    return None


def sdk_versions() -> list[str]:
    out = subprocess.run("dotnet --list-sdks", shell=True, capture_output=True, text=True).stdout
    return re.findall(r"^(\S+) \[", out, re.M)


def global_json(d: Path) -> dict:
    try:
        return json.loads((d / "global.json").read_text())
    except (OSError, ValueError):
        return {}


def pin_sdk(d: Path) -> None:
    """A global.json that asks for an SDK not installed here (a .NET preview, say) makes every dotnet command fail
    before it starts: point it at the newest installed SDK. The working copy is reset at the next checkout."""
    g = global_json(d)
    want = (g.get("sdk") or {}).get("version")
    have = sdk_versions()
    if not want or not have or want in have:
        return
    if any(v.split(".")[0] == want.split(".")[0] for v in have) and (g["sdk"].get("rollForward") or "").startswith("latest"):
        return
    newest = max(have, key=lambda v: [int(x) if x.isdigit() else -1 for x in re.split(r"[.-]", v)])
    g["sdk"] = {**g["sdk"], "version": newest, "rollForward": "latestFeature", "allowPrerelease": True}
    (d / "global.json").write_text(json.dumps(g, indent=2))


def uses_mtp(d: Path) -> bool:
    """Microsoft.Testing.Platform projects need the new `dotnet test --project ...` syntax (.NET 10 SDK and later)."""
    return (global_json(d).get("test") or {}).get("runner") == "Microsoft.Testing.Platform"


def lists_unbuildable_tfm(proj: Path, stop: Path) -> bool:
    texts = [proj.read_text(errors="replace")]
    p = proj.parent
    while True:
        props = p / "Directory.Build.props"
        if props.exists():
            texts.append(props.read_text(errors="replace"))
        if p == stop or p == p.parent:
            break
        p = p.parent
    return any(int(n) > sdk_major() for t in texts for n in re.findall(r"\bnet(\d+)\.0\b", t))


def dotnet_test_cmd(d: Path, test: str) -> str | None:
    p = (d / test).parent
    while p != d.parent:
        projs = sorted(p.glob("*.csproj"))
        if projs:
            proj, cls = projs[0], Path(test).stem
            tf = target_framework(proj, d)
            fw = f" -f {tf}" if tf else ""
            fw += " -p:EnableSourceLink=false -p:EnableSourceControlManagerQueries=false"  # old SourceLink can't read worktrees
            if tf and lists_unbuildable_tfm(proj, d):
                fw += f" -p:TargetFrameworks={tf}"  # restore fails on any target whose SDK is missing
            if uses_mtp(d):
                xunit3 = "xunit.v3" in proj.read_text(errors="replace") or any(
                    "xunit.v3" in f.read_text(errors="replace") for f in d.glob("Directory.Packages.props"))
                filt = f"--filter-class '*{cls}'" if xunit3 else f'--filter "FullyQualifiedName~{cls}"'
                return f"dotnet test --project {q(str(proj))}{fw} -- {filt}"
            return f"dotnet test {q(str(proj))}{fw} --nologo -v q --filter \"FullyQualifiedName~{cls}\""
        p = p.parent
    return None


def oom(r: subprocess.CompletedProcess, text: str) -> bool:
    return r.returncode in (137, -9) or "exited with code 137" in text


def run_fix_tests(lang: str, d: Path, test_files: list[str], row: list[str], stage: str) -> tuple[int, int, int, str]:
    """(passed, failed, files that did not load or compile, output) for these test files in working copy `d`
    (TypeScript or C#; the project's dependencies already installed)."""
    passed = failed = broken = 0
    out = ""
    if len(row) > 2 and row[2]:
        r = sh(f"cd {q(str(d))} && " + row[2].replace("{files}", " ".join(q(t) for t in test_files)), d)
        return (1, 0, 0, "") if r.returncode == 0 else (0, 1, 0, (r.stdout + r.stderr)[-2000:])
    if lang == "typescript":
        for i, t in enumerate(test_files):
            report = d.parent / f".{d.name}-{stage}-{i}.json"
            report.unlink(missing_ok=True)
            r = sh(node_test_cmd(d, t, report), d)
            p_, f_, b_ = read_report(report)
            if (p_, f_, b_) == (0, 0, 0) and r.returncode != 0:
                b_ = 1  # no report at all: the runner could not start this file
            passed, failed, broken, out = passed + p_, failed + f_, broken + b_, out + (r.stdout + r.stderr)[-1500:]
            report.unlink(missing_ok=True)
        return passed, failed, broken, out
    for cmd in [x for x in (dotnet_test_cmd(d, t) for t in test_files) if x]:
        r = sh(cmd, d)
        text = r.stdout + r.stderr
        if oom(r, text):  # the compiler was killed for memory: one build node uses less
            r = sh(cmd.replace(" -- ", " -m:1 -- ", 1) if " -- " in cmd else cmd + " -m:1", d)
            text = r.stdout + r.stderr
            if oom(r, text):
                raise RuntimeError("build ran out of memory")
        out += text[-2000:]
        m = re.search(r"Failed:\s*(\d+),\s*Passed:\s*(\d+)", text)
        mtp = re.search(r"total:\s*(\d+)\s+failed:\s*(\d+)\s+succeeded:\s*(\d+)", text)
        if mtp:  # a test-run summary means everything compiled; failing tests may print anything
            failed, passed = failed + int(mtp.group(2)), passed + int(mtp.group(3))
        elif "error CS" in text or "Build FAILED" in text or re.search(r": error (CS|MSB|NETSDK)", text):
            broken += 1
        elif m:
            failed, passed = failed + int(m.group(1)), passed + int(m.group(2))
        elif r.returncode != 0:
            broken += 1
        else:
            m2 = re.search(r"Passed!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+)", text)
            passed += int(m2.group(2)) if m2 else 1
    return passed, failed, broken, out


run_fix_tests.no_project = lambda d, test_files: not any(dotnet_test_cmd(d, t) for t in test_files)


def validate_copy(c: dict, wc: WorkingCopy, row: list[str]) -> tuple[bool | None, str]:
    lang = c["language"]
    wc.checkout(c["sha"])
    d = wc.dir
    install = row[1] if len(row) > 1 and row[1] else (node_install_cmd(d) if lang == "typescript" else "true")  # dotnet test restores by itself
    lh = wc.lock_hash()
    if wc.installed_for != lh:
        r = sh(install, d, timeout=1800)
        if r.returncode != 0:
            return None, f"install failed: {(r.stderr or r.stdout)[-300:]}"
        wc.installed_for = lh
    if lang == "csharp":
        pin_sdk(d)
    run = lambda stage: run_fix_tests(lang, d, c["test_files"], row, stage)  # noqa: E731
    if lang == "csharp" and not (len(row) > 2 and row[2]) and run_fix_tests.no_project(d, c["test_files"]):
        return None, "no test project found"

    p_after, f_after, b_after, out_after = run("after")
    if f_after or b_after or not p_after:
        tail = " ".join(out_after.split())[-240:] if b_after else ""
        return None, f"tests do not pass on the fix itself (passed {p_after}, failed {f_after}, not loading {b_after}) {tail}".rstrip()
    src = " ".join(q(s) for s in c["src_files"])
    sh(f"git checkout {c['sha']}^ -- {src}", d)
    p_before, f_before, b_before, _ = run("before")
    if f_before:
        return True, f"{f_before} test(s) fail before the fix, all pass after"
    if b_before:
        return False, "tests no longer load or compile before the fix (an API change, not a bug)"
    return False, "tests pass before the fix too"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--candidates", default="data/candidates.jsonl")
    ap.add_argument("--repos", default="data/repos/repos.txt")
    ap.add_argument("--workdir", default="data/raw")
    ap.add_argument("--copies", default="data/work/validate", help="persistent working copies (TypeScript, C#)")
    ap.add_argument("--out", default="data/bugs.jsonl")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--only-repo", default=None, help="validate only candidates from this repository name")
    args = ap.parse_args(argv)

    rows = {r[0]: r for r in repo_lines(args.repos)}
    cands = [json.loads(l) for l in Path(args.candidates).read_text().splitlines() if l.strip()]
    if args.only_repo:
        cands = [c for c in cands if c["name"] == args.only_repo]
    out_path, rej_path = Path(args.out), Path(args.out).with_suffix(".rejected.jsonl")
    skip_path = Path(args.out).with_suffix(".skipped.jsonl")
    done = set()
    for p in (out_path, rej_path, skip_path):
        if p.exists():
            done |= {(json.loads(l)["name"], json.loads(l)["sha"]) for l in p.read_text().splitlines() if l.strip()}
    cands = [c for c in cands if (c["name"], c["sha"]) not in done]
    if args.limit:
        cands = cands[: args.limit]
    print(f"{len(cands)} candidates to validate ({len(done)} already done)", flush=True)
    copies: dict[str, WorkingCopy] = {}
    ok = 0
    with open(out_path, "a") as out, open(rej_path, "a") as rej, open(skip_path, "a") as skp:
        for c in cands:
            repo = Path(args.workdir) / c["name"]
            lang = c.get("language", "python")
            t0 = time.time()
            try:
                if lang == "python":
                    row = rows.get(c["repo"], [c["repo"]])
                    confirmed, why = validate_python(c, repo, row[1] if len(row) > 1 else None)
                else:
                    wc = copies.setdefault(c["name"], WorkingCopy(repo, Path(args.copies)))
                    confirmed, why = validate_copy(c, wc, rows.get(c["repo"], [c["repo"]]))
            except subprocess.TimeoutExpired:
                confirmed, why = None, "timed out"
            except RuntimeError as e:
                confirmed, why = None, str(e)
            tag = "CONFIRMED" if confirmed else ("rejected " if confirmed is False else "SKIP     ")
            print(f"{tag} {c['name']} {c['sha'][:8]} {c['subject'][:60]}  ({why[:80]}; {time.time() - t0:.0f}s)", flush=True)
            if confirmed:
                # a TypeScript type-level test (expectTypeOf in *.test-d.ts) proves a type bug, not a runtime one
                c["bug_kind"] = "types" if all(re.search(r"-d\.[cm]?tsx?$|\.types?\.test", t) for t in c["test_files"]) else "runtime"
                out.write(json.dumps(c) + "\n")
                out.flush()
                ok += 1
            elif confirmed is False:
                rej.write(json.dumps({**c, "why": why}) + "\n")
                rej.flush()
            else:  # could not be judged (install, broken tests at the fix): not retried
                skp.write(json.dumps({**c, "why": why}) + "\n")
                skp.flush()
    print(f"{ok} confirmed bugs -> {args.out}")
