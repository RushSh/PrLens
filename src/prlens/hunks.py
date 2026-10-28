"""PR diffs as hunks, and the triage rules that need no model.

- `parse_diff` turns `git diff` output into files and hunks (old/new line numbers kept per line).
- `skip_category` clears hunks a human never needs to read, by path (lock files, generated code, docs, CI and
  tool config, test data) or by proof (a Python hunk whose syntax tree is unchanged is formatting or comments only;
  one that only changes docstrings is docs).
- `review_rules` forces hunks into review whatever their score: migrations, security-sensitive code, public API
  signatures.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")


@dataclass
class Line:
    kind: str  # "add" | "del" | "ctx"
    old: int | None
    new: int | None
    text: str


@dataclass
class Hunk:
    file: str
    old_file: str | None
    header: str
    old_start: int
    old_len: int
    new_start: int
    new_len: int
    lines: list[Line] = field(default_factory=list)

    @property
    def added(self) -> int:
        return sum(1 for l in self.lines if l.kind == "add")

    @property
    def removed(self) -> int:
        return sum(1 for l in self.lines if l.kind == "del")

    @property
    def size(self) -> int:
        return self.added + self.removed

    def new_lines(self) -> set[int]:
        return {l.new for l in self.lines if l.kind == "add" and l.new is not None}


@dataclass
class FileDiff:
    old_path: str | None
    new_path: str | None
    binary: bool = False
    hunks: list[Hunk] = field(default_factory=list)


def parse_diff(text: str) -> list[FileDiff]:
    files: list[FileDiff] = []
    cur: FileDiff | None = None
    hunk: Hunk | None = None
    o = n = 0
    for raw in text.splitlines():
        if raw.startswith("diff --git "):
            cur = FileDiff(None, None)
            files.append(cur)
            hunk = None
            m = re.match(r"diff --git a/(.*) b/(.*)$", raw)
            if m:
                cur.old_path, cur.new_path = m.group(1), m.group(2)
            continue
        if cur is None:
            continue
        if hunk is None or raw.startswith(("--- ", "+++ ", "Binary files", "@@")):
            if raw.startswith("--- "):
                cur.old_path = None if raw[4:] == "/dev/null" else raw[6:]
                continue
            if raw.startswith("+++ "):
                cur.new_path = None if raw[4:] == "/dev/null" else raw[6:]
                continue
            if raw.startswith("Binary files"):
                cur.binary = True
                continue
            m = HUNK_RE.match(raw)
            if m:
                os_, ol, ns, nl, ctx = m.groups()
                hunk = Hunk(
                    file=cur.new_path or cur.old_path or "",
                    old_file=cur.old_path,
                    header=raw,
                    old_start=int(os_),
                    old_len=int(ol) if ol is not None else 1,
                    new_start=int(ns),
                    new_len=int(nl) if nl is not None else 1,
                )
                cur.hunks.append(hunk)
                o, n = hunk.old_start, hunk.new_start
                continue
            if hunk is None:
                continue
        if raw.startswith("\\"):
            continue
        tag, body = (raw[:1], raw[1:]) if raw else (" ", "")
        if tag == "+":
            hunk.lines.append(Line("add", None, n, body))
            n += 1
        elif tag == "-":
            hunk.lines.append(Line("del", o, None, body))
            o += 1
        else:
            hunk.lines.append(Line("ctx", o, n, body))
            o += 1
            n += 1
    return files


# ---------------------------------------------------------------- skip rules (no model)

LOCK_NAMES = {"poetry.lock", "pdm.lock", "uv.lock", "Pipfile.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Cargo.lock"}
DOC_NAMES = {"changelog", "changes", "history", "news", "authors", "contributors", "readme", "license", "copying", "notice"}
DOC_EXT = {".md", ".rst", ".txt", ".adoc"}
CONFIG_NAMES = {"tox.ini", ".flake8", "mypy.ini", ".coveragerc", ".gitignore", ".gitattributes", ".editorconfig",
                ".pre-commit-config.yaml", ".readthedocs.yml", ".readthedocs.yaml", "codecov.yml", ".codecov.yml",
                "manifest.in", ".git-blame-ignore-revs", "noxfile.py", ".mailmap", "dependabot.yml"}
CONFIG_DIRS = {".github", ".circleci", ".gitlab", ".azure-pipelines", ".ci"}
GENERATED_MARK = ("_pb2.py", "_pb2_grpc.py", ".min.js", ".min.css")
GENERATED_DIRS = {"vendor", "_vendor", "vendored", "generated", "_generated"}


def path_category(path: str) -> str | None:
    p = PurePosixPath(path)
    name = p.name.lower()
    parts = [x.lower() for x in p.parts[:-1]]
    if p.name in LOCK_NAMES:
        return "dependency_lock"
    if any(d in GENERATED_DIRS for d in parts) or name.endswith(GENERATED_MARK):
        return "generated"
    if any(d in CONFIG_DIRS for d in parts) or name in CONFIG_NAMES:
        return "config"
    if p.stem.lower() in DOC_NAMES or (p.suffix.lower() in DOC_EXT and not name.startswith("requirements")):
        return "docs"
    if parts and parts[0] in {"docs", "doc"} and p.suffix.lower() != ".py":
        return "docs"
    if any(d in {"tests", "test", "testing"} for d in parts) and p.suffix.lower() not in {".py"}:
        return "test_fixture"
    return None


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
                    and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _dump(src: str, strip_docs: bool) -> str | None:
    try:
        t = ast.parse(src)
    except (SyntaxError, ValueError):
        return None
    if strip_docs:
        t = _strip_docstrings(t)
    return ast.dump(t, annotate_fields=False, include_attributes=False)


def apply_hunk(old_src: str, h: Hunk) -> str:
    """The old file with only this hunk applied."""
    lines = old_src.splitlines()
    start = h.old_start - 1 if h.old_len else h.old_start
    new_part = [l.text for l in h.lines if l.kind in ("add", "ctx")]
    return "\n".join(lines[:start] + new_part + lines[start + h.old_len:]) + "\n"


def python_proof(old_src: str | None, h: Hunk) -> str | None:
    """'formatting' if the hunk leaves the syntax tree unchanged, 'docs' if only docstrings change, else None."""
    if old_src is None or not h.file.endswith(".py"):
        return None
    try:
        new_src = apply_hunk(old_src, h)
    except Exception:
        return None
    a, b = _dump(old_src, False), _dump(new_src, False)
    if a is None or b is None:
        return None
    if a == b:
        return "formatting"
    if _dump(old_src, True) == _dump(new_src, True):
        return "docs"
    return None


def skip_category(h: Hunk, old_src: str | None) -> tuple[str, str] | None:
    """(category, reason) when the hunk can be skipped without a model, else None."""
    cat = path_category(h.file)
    if cat:
        return cat, f"{PurePosixPath(h.file).name} is {cat.replace('_', ' ')}"
    proof = python_proof(old_src, h)
    if proof == "formatting":
        return "formatting", "Syntax tree unchanged: whitespace, line breaks or comments only"
    if proof == "docs":
        return "docs", "Only docstrings change; the code is identical"
    return None


# ---------------------------------------------------------------- must-review rules

SECURITY_RE = re.compile(r"(\bauth(entication|orization|orize|enticate)?\b|\bpermissions?\b|\bpassw(or)?d\b|\bsecret\b|"
                         r"\bcredentials?\b|\bcrypto\w*|\bhmac\b|\bcsrf\b|\bpickle\.loads?\b|\beval\(|\bexec\(|"
                         r"\bos\.system\(|shell\s*=\s*True|\bverify\s*=\s*False\b)", re.I)
DEF_RE = re.compile(r"^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)")


def defs_in(lines, kind: str) -> set[str]:
    return {m.group(3) for l in lines if l.kind == kind and (m := DEF_RE.match(l.text))
            and len(m.group(1)) <= 4 and not m.group(3).startswith("_")}


def review_rules(h: Hunk, pr_added_defs: set[str] | None = None) -> list[tuple[str, str]]:
    """`pr_added_defs`: public names defined on added lines anywhere in the PR (a def that moved is not removed)."""
    out = []
    low = h.file.lower()
    if "migration" in low or "alembic" in low:
        out.append(("data_migration", "Database migration"))
    changed = [l.text for l in h.lines if l.kind != "ctx"]
    if any(SECURITY_RE.search(t) for t in changed):
        out.append(("security_sensitive", "Touches security-sensitive code"))
    if h.file.endswith(".py") and "/test" not in "/" + low and not PurePosixPath(low).name.startswith("test"):
        # a public def whose signature changed, or that was removed outright, breaks callers; a new one does not
        gone = defs_in(h.lines, "del")
        # a def line on both sides of the diff means its text changed (whitespace-only edits are skipped earlier)
        changed = gone & defs_in(h.lines, "add")
        removed = gone - defs_in(h.lines, "add") - (pr_added_defs or set())
        if changed:
            out.append(("public_api", f"Changes the signature of public `{sorted(changed)[0]}`"))
        elif removed:
            out.append(("public_api", f"Removes public `{sorted(removed)[0]}`"))
        elif any(l.kind != "ctx" and l.text.startswith("__all__") for l in h.lines):
            out.append(("public_api", "Changes __all__"))
    return out


# ---------------------------------------------------------------- regions: hunks cut to reviewable size

REGION_MAX = 25
BOUNDARY_RE = re.compile(r"^\s*(@|def |async def |class )|^\s*$")


def regions(h: Hunk) -> list[Hunk]:
    """Cut a hunk into runs of changed lines (context between runs dropped), and cut long runs at blank lines or
    def/class starts so no region is much over REGION_MAX changed lines. Each region keeps one line of context
    either side so it still reads as a diff."""
    runs: list[list[Line]] = []
    cur: list[Line] = []
    for l in h.lines:
        if l.kind == "ctx":
            if cur:
                runs.append(cur)
                cur = []
        else:
            cur.append(l)
    if cur:
        runs.append(cur)
    pieces: list[list[Line]] = []
    for run in runs:
        start = 0
        while len(run) - start > REGION_MAX:
            cut = None
            for j in range(min(len(run), start + REGION_MAX + 10) - 1, start + 5, -1):
                if j - start <= REGION_MAX + 10 and run[j].kind == "add" and BOUNDARY_RE.match(run[j].text):
                    cut = j
                    if j - start <= REGION_MAX:
                        break
            cut = cut or start + REGION_MAX
            pieces.append(run[start:cut])
            start = cut
        pieces.append(run[start:])
    out = []
    for piece in pieces:
        first = next((l for l in piece if l.new is not None), None)
        out.append(Hunk(file=h.file, old_file=h.old_file, header=h.header,
                        old_start=next((l.old for l in piece if l.old is not None), h.old_start), old_len=0,
                        new_start=first.new if first else h.new_start, new_len=0, lines=piece))
    return out
