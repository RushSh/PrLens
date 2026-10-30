"""PR diffs as hunks, and the triage rules that need no model.

- `parse_diff` turns `git diff` output into files and hunks (old/new line numbers kept per line).
- `skip_category` clears hunks a human never needs to read, by path (lock files, generated code, docs, CI and
  tool config, test data) or by proof (a Python hunk whose syntax tree is unchanged is formatting or comments only;
  one that only changes docstrings is docs).
- `review_rules` forces hunks into review whatever their score: migrations, security-sensitive code, public API
  signatures.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import PurePosixPath

from .languages import BOUNDARY_RE as LANG_BOUNDARY, defined_names, formatting_proof, is_test, language_of, public_names, LANGUAGES

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

LOCK_NAMES = {"poetry.lock", "pdm.lock", "uv.lock", "Pipfile.lock", "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
              "Cargo.lock", "bun.lockb", "bun.lock", "packages.lock.json", "npm-shrinkwrap.json"}
DOC_NAMES = {"changelog", "changes", "history", "news", "authors", "contributors", "readme", "license", "copying", "notice"}
DOC_EXT = {".md", ".rst", ".txt", ".adoc"}
CONFIG_NAMES = {"tox.ini", ".flake8", "mypy.ini", ".coveragerc", ".gitignore", ".gitattributes", ".editorconfig",
                ".pre-commit-config.yaml", ".readthedocs.yml", ".readthedocs.yaml", "codecov.yml", ".codecov.yml",
                "manifest.in", ".git-blame-ignore-revs", "noxfile.py", ".mailmap", "dependabot.yml"}
CONFIG_DIRS = {".github", ".circleci", ".gitlab", ".azure-pipelines", ".ci"}
GENERATED_MARK = ("_pb2.py", "_pb2_grpc.py", ".min.js", ".min.css", ".d.ts", ".designer.cs", ".g.cs", ".g.i.cs")
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
    if any(d in {"tests", "test", "testing", "__tests__", "fixtures", "testdata"} for d in parts) and language_of(path) is None \
            and p.suffix.lower() not in {".py"}:
        return "test_fixture"  # data files under test folders; test code is scored like any code
    return None


def apply_hunk(old_src: str, h: Hunk) -> str:
    """The old file with only this hunk applied."""
    lines = old_src.splitlines()
    start = h.old_start - 1 if h.old_len else h.old_start
    new_part = [l.text for l in h.lines if l.kind in ("add", "ctx")]
    return "\n".join(lines[:start] + new_part + lines[start + h.old_len:]) + "\n"


def proof(old_src: str | None, h: Hunk) -> str | None:
    """'formatting' if applying the hunk provably changes nothing but layout or comments, 'docs' if only Python
    docstrings change (see languages.formatting_proof), else None."""
    if old_src is None or language_of(h.file) is None:
        return None
    try:
        new_src = apply_hunk(old_src, h)
    except Exception:
        return None
    return formatting_proof(h.file, old_src, new_src)


python_proof = proof  # earlier name


def skip_category(h: Hunk, old_src: str | None) -> tuple[str, str] | None:
    """(category, reason) when the hunk can be skipped without a model, else None."""
    cat = path_category(h.file)
    if cat:
        return cat, f"{PurePosixPath(h.file).name} is {cat.replace('_', ' ')}"
    result = proof(old_src, h)
    if result == "formatting":
        return "formatting", "Syntax tree unchanged: whitespace, line breaks or comments only"
    if result == "docs":
        return "docs", "Only docstrings change; the code is identical"
    return None


# ---------------------------------------------------------------- must-review rules

SECURITY_RE = re.compile(r"(\bauth(entication|orization|orize|enticate)?\b|\bpermissions?\b|\bpassw(or)?d\b|\bsecret\b|"
                         r"\bcredentials?\b|\bcrypto\w*|\bhmac\b|\bcsrf\b|\bpickle\.loads?\b|\beval\(|\bexec\(|"
                         r"\bos\.system\(|shell\s*=\s*True|\bverify\s*=\s*False\b|"
                         # TypeScript / JavaScript
                         r"dangerouslySetInnerHTML|\.innerHTML\b|\bnew Function\(|\bchild_process\b|"
                         # C#
                         r"\bProcess\.Start\(|\bSqlCommand\b|\bFromSqlRaw\b|\bBinaryFormatter\b|\bAllowAnonymous\b)", re.I)


def defs_in(lines, kind: str, path: str | None = None) -> set[str]:
    """Public names defined on lines of this kind; for added lines also assignments, so `Token = namedtuple(...)`
    replacing `class Token` is not a removal. Without a path, every language's rules are applied (a whole PR)."""
    texts = [l.text for l in lines if l.kind == kind]
    langs = [language_of(path)] if path and language_of(path) else list(LANGUAGES.values())
    names: set[str] = set()
    for lang in langs:
        names |= defined_names(lang, texts) if kind == "add" else public_names(lang, texts)
    return names


THROW_RE = {"python": re.compile(r"^\s*raise\b"), "typescript": re.compile(r"\bthrow\b"),
            "csharp": re.compile(r"\bthrow\b")}
CATCH_ALL_RE = {
    "python": re.compile(r"^\s*except\s*(\(?\s*(BaseException|Exception)\s*\)?)?\s*(as\s+\w+\s*)?:"),
    "csharp": re.compile(r"^\s*(\}\s*)?catch\s*(\(\s*(System\.)?Exception(\s+\w+)?\s*\))?\s*(\{.*)?$"),
}
COMMENT_RE = re.compile(r"^\s*(#|//|/\*|\*)")


def error_handling_rule(lang, added: list[str], deleted: list[str]) -> tuple[str, str] | None:
    """A removed `throw`/`raise`, or a new catch-all handler: a failure may now pass silently, which a reviewer should
    decide on (filtered C# catches, `catch (X) when (...)`, are not catch-alls)."""
    code = lambda ls: [t for t in ls if not COMMENT_RE.match(t)]
    added, deleted = code(added), code(deleted)
    throw = THROW_RE.get(lang.name)
    if throw and sum(bool(throw.search(t)) for t in deleted) > sum(bool(throw.search(t)) for t in added):
        word = "raise" if lang.name == "python" else "throw"
        return ("error_handling", f"Removes a `{word}`: an error may now be swallowed or turned into a default value")
    catch_all = CATCH_ALL_RE.get(lang.name)
    if catch_all:
        new = [t for t in added if catch_all.match(t) and " when " not in t and t.strip() not in {d.strip() for d in deleted}]
        if new:
            return ("error_handling", "Adds a catch-all exception handler: failures it catches pass silently")
    return None


def review_rules(h: Hunk, pr_added_defs: set[str] | None = None) -> list[tuple[str, str]]:
    """`pr_added_defs`: public names defined on added lines anywhere in the PR (a def that moved is not removed)."""
    out = []
    low = h.file.lower()
    if "migration" in low or "alembic" in low:
        out.append(("data_migration", "Database migration"))
    changed = [l.text for l in h.lines if l.kind != "ctx"]
    if any(SECURITY_RE.search(t) for t in changed):
        out.append(("security_sensitive", "Touches security-sensitive code"))
    lang = language_of(h.file)
    if lang and not is_test(h.file):
        # a public definition whose signature changed, or that was removed outright, breaks callers; a new one does not
        gone = public_names(lang, [l.text for l in h.lines if l.kind == "del"])
        now = public_names(lang, [l.text for l in h.lines if l.kind == "add"])
        sig_changed = gone & now  # a definition line on both sides of the diff means its text changed
        removed = gone - defined_names(lang, [l.text for l in h.lines if l.kind == "add"]) - (pr_added_defs or set())
        if sig_changed:
            out.append(("public_api", f"Changes the signature of public `{sorted(sig_changed)[0]}`"))
        elif removed:
            out.append(("public_api", f"Removes public `{sorted(removed)[0]}`"))
        elif lang.name == "python" and any(l.kind != "ctx" and l.text.startswith("__all__") for l in h.lines):
            out.append(("public_api", "Changes __all__"))
        eh = error_handling_rule(lang, [l.text for l in h.lines if l.kind == "add"], [l.text for l in h.lines if l.kind == "del"])
        if eh:
            out.append(eh)
    return out


# ---------------------------------------------------------------- regions: hunks cut to reviewable size

REGION_MAX = 25
BOUNDARY_RE = LANG_BOUNDARY["python"]  # earlier name; regions() picks the file's language


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
    boundary = LANG_BOUNDARY[(language_of(h.file) or LANGUAGES["python"]).name]
    pieces: list[list[Line]] = []
    for run in runs:
        start = 0
        while len(run) - start > REGION_MAX:
            cut = None
            for j in range(min(len(run), start + REGION_MAX + 10) - 1, start + 5, -1):
                if j - start <= REGION_MAX + 10 and run[j].kind == "add" and boundary.match(run[j].text):
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
