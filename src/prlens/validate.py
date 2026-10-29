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
        before = sh(f".venv/bin/python -m pytest -x -q {tests}", wt)
        return after.returncode == 0 and before.returncode != 0, f"after={after.returncode} before={before.returncode}"
    finally:
        sh(f"git worktree remove --force {wt}", repo)
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------- TypeScript and C#: one working copy per repo

LOCKFILES = ("pnpm-lock.yaml", "yarn.lock", "package-lock.json", "bun.lock", "bun.lockb", "packages.lock.json")


class WorkingCopy:
    def __init__(self, repo: Path, root: Path):
        self.repo = repo
        self.dir = root / repo.name
        self.installed_for: str | None = None
        if not (self.dir / ".git").exists():
            self.dir.parent.mkdir(parents=True, exist_ok=True)
            sh(f"git worktree prune && git worktree add --detach {q(str(self.dir))} HEAD", repo)

    def checkout(self, rev: str) -> None:
        sh("git reset -q --hard && git clean -qfdx -e node_modules -e bin -e obj", self.dir)
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
        return "corepack pnpm install --frozen-lockfile || npx -y pnpm@9 install --frozen-lockfile"
    if (d / "yarn.lock").exists():
        return "corepack yarn install --immutable || corepack yarn install --frozen-lockfile"
    if (d / "bun.lock").exists() or (d / "bun.lockb").exists():
        return "bun install --frozen-lockfile"
    if (d / "package-lock.json").exists():
        return "npm ci --no-audit --no-fund"
    return "npm install --no-audit --no-fund"


def node_test_cmd(d: Path, test: str) -> str:
    """Run one test file with the runner of the nearest package that has one (monorepos: packages/zod, library/)."""
    p = (d / test).parent
    while True:
        pkg = p / "package.json"
        if pkg.exists():
            meta = json.loads(pkg.read_text())
            deps = {**meta.get("dependencies", {}), **meta.get("devDependencies", {})}
            rel = (d / test).relative_to(p).as_posix()
            if "vitest" in deps or (p / "vitest.config.ts").exists() or (p / "vitest.config.mts").exists():
                return f"cd {q(str(p))} && npx vitest run {q(rel)}"
            if "jest" in deps or (p / "jest.config.js").exists() or (p / "jest.config.ts").exists():
                return f"cd {q(str(p))} && npx jest {q(rel)}"
        if p == d or p == p.parent:
            break
        p = p.parent
    return f"npx vitest run {q(test)}"


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
    for text in texts:
        m = re.search(r"<TargetFrameworks?>([^<]+)</TargetFrameworks?>", text)
        if m:
            tfms = [t.strip() for t in m.group(1).split(";") if re.fullmatch(r"net(\d+)\.0", t.strip())]
            ok = [t for t in tfms if int(t[3:-2]) <= sdk_major()]
            return max(ok, key=lambda t: int(t[3:-2])) if ok else None
    return None


def dotnet_test_cmd(d: Path, test: str) -> str | None:
    p = (d / test).parent
    while p != d.parent:
        projs = sorted(p.glob("*.csproj"))
        if projs:
            cls = Path(test).stem
            tf = target_framework(projs[0], d)
            fw = f" -f {tf}" if tf else ""
            return f"dotnet test {q(str(projs[0]))}{fw} --nologo -v q --filter \"FullyQualifiedName~{cls}\""
        p = p.parent
    return None


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
    if len(row) > 2 and row[2]:
        cmds = [f"cd {q(str(d))} && " + row[2].replace("{files}", " ".join(q(t) for t in c["test_files"]))]
    elif lang == "typescript":
        cmds = [node_test_cmd(d, t) for t in c["test_files"]]
    else:
        cmds = [x for x in (dotnet_test_cmd(d, t) for t in c["test_files"]) if x]
        if not cmds:
            return None, "no test project found"

    def run_all() -> tuple[bool, str]:
        out = ""
        for cmd in cmds:
            r = sh(cmd, d)
            out += (r.stdout + r.stderr)[-2000:]
            if r.returncode != 0:
                return False, out
        return True, out

    after_ok, _ = run_all()
    if not after_ok:
        return False, "tests fail on the fix itself"
    src = " ".join(q(s) for s in c["src_files"])
    sh(f"git checkout {c['sha']}^ -- {src}", d)
    before_ok, out = run_all()
    if before_ok:
        return False, "tests pass before the fix too"
    if lang == "csharp" and ("error CS" in out or "Build FAILED" in out):
        return False, "tests do not compile before the fix (an API change, not a bug)"
    return True, "fails before, passes after"


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
    done = set()
    for p in (out_path, rej_path):
        if p.exists():
            done |= {(json.loads(l)["name"], json.loads(l)["sha"]) for l in p.read_text().splitlines() if l.strip()}
    cands = [c for c in cands if (c["name"], c["sha"]) not in done]
    if args.limit:
        cands = cands[: args.limit]
    print(f"{len(cands)} candidates to validate ({len(done)} already done)", flush=True)
    copies: dict[str, WorkingCopy] = {}
    ok = 0
    with open(out_path, "a") as out, open(rej_path, "a") as rej:
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
    print(f"{ok} confirmed bugs -> {args.out}")
