"""Everything PR Lens needs to know about a language, in one place: which files are code, which are tests, where
regions may be cut, which changes break callers, what counts as logic, and when a change is provably formatting
only. Python, TypeScript (and JavaScript) and C#.

Formatting proofs:
- Python: the syntax tree is unchanged (ast), or only docstrings changed.
- TypeScript and C#: the token stream is unchanged once whitespace and comments are dropped (strings, template
  literals, verbatim and interpolated strings are kept whole). For TypeScript the proof is refused when a line break
  moved next to `return`, `throw`, `break`, `continue`, `yield`, `++` or `--`, where automatic semicolon insertion can
  change meaning.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from pathlib import PurePosixPath


@dataclass(frozen=True)
class Language:
    name: str
    exts: tuple[str, ...]
    #: start of a top-level-ish definition (for region boundaries and public-API rules); group "name" is the name
    def_re: re.Pattern
    #: tokens that count toward "logic density"
    logic_re: re.Pattern

    def is_code(self, path: str) -> bool:
        p = path.lower()
        return p.endswith(self.exts) and not p.endswith(".d.ts")


PY_LOGIC = re.compile(r"(\bif\b|\belif\b|\bwhile\b|\bfor\b|\band\b|\bor\b|\bnot\b|[<>]=?|==|!=|\[[^\]]*:[^\]]*\]|[+-]\s*1\b|\breturn\b|\bexcept\b|\bis\b|\bin\b)")
C_LOGIC = re.compile(r"(\bif\b|\belse\b|\bwhile\b|\bfor\b|\bforeach\b|\bswitch\b|\bcase\b|&&|\|\||\?\?|\?\.|[<>]=?|===?|!==?|!(?!=)|[+-]\s*1\b|\breturn\b|\bcatch\b|\bthrow\b|\?)")

PYTHON = Language(
    "python", (".py",),
    re.compile(r"^(?P<indent>\s*)(?:async\s+def|def|class)\s+(?P<name>[A-Za-z_]\w*)"),
    PY_LOGIC,
)
TYPESCRIPT = Language(
    "typescript", (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"),
    re.compile(r"^(?P<indent>\s*)(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?"
               r"(?:function\*?|class|interface|type|enum|const|let|namespace)\s+(?P<name>[A-Za-z_$][\w$]*)"),
    C_LOGIC,
)
CSHARP = Language(
    "csharp", (".cs",),
    re.compile(r"^(?P<indent>\s*)(?:\[[^\]]*\]\s*)*(?P<mods>(?:(?:public|private|protected|internal|static|virtual|override|"
               r"abstract|sealed|async|partial|readonly|unsafe|extern|new)\s+)+)[\w<>\[\],.?\s]*?\b"
               r"(?:class|struct|interface|record|enum|(?P<ret>[\w<>\[\],.?]+))\s+(?P<name>[A-Za-z_]\w*)\s*[(<{:]?"),
    C_LOGIC,
)
LANGUAGES = {lang.name: lang for lang in (PYTHON, TYPESCRIPT, CSHARP)}


def language_of(path: str) -> Language | None:
    for lang in LANGUAGES.values():
        if lang.is_code(path):
            return lang
    return None


# ---------------------------------------------------------------- tests

TEST_DIRS = {"test", "tests", "testing", "__tests__", "spec", "specs", "__mocks__", "fixtures", "testdata"}


def is_test(path: str) -> bool:
    p = PurePosixPath(path)
    name = p.name.lower()
    parts = [x.lower() for x in p.parts[:-1]]
    if any(x in TEST_DIRS for x in parts):
        return True
    if any(x.endswith((".tests", ".test", ".specs", ".unittests", ".integrationtests")) or x.endswith("tests") for x in parts):
        return True  # C# test projects: Humanizer.Tests/, src/Foo.UnitTests/
    stem = p.stem.lower()
    if stem in {"test", "tests", "spec", "specs"}:
        return True  # date-fns style: src/addDays/test.ts
    return (name.startswith("test_") or stem.endswith("_test")
            or re.search(r"\.(test|spec)$", stem) is not None
            or (p.suffix.lower() == ".cs" and (stem.endswith("tests") or stem.endswith("test"))))


# ---------------------------------------------------------------- public API

def public_names(lang: Language, lines: list[str]) -> set[str]:
    """Names of public definitions on these lines (module or class level)."""
    out = set()
    for text in lines:
        m = lang.def_re.match(text)
        if not m:
            continue
        name = m.group("name")
        if lang is PYTHON:
            if len(m.group("indent")) <= 4 and not name.startswith("_"):
                out.add(name)
        elif lang is TYPESCRIPT:
            if text.lstrip().startswith("export"):
                out.add(name)
        elif lang is CSHARP:
            mods = m.group("mods") or ""
            if "public" in mods or "protected" in mods:
                out.add(name)
    return out


ASSIGN_RE = {
    "python": re.compile(r"^(?P<name>[A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)"),
    "typescript": re.compile(r"^export\s+(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)"),
    "csharp": re.compile(r"^\s*public\s+[\w<>\[\],.?\s]+\s(?P<name>[A-Za-z_]\w*)\s*(?:=|\{|=>)"),
}


def defined_names(lang: Language, lines: list[str]) -> set[str]:
    """Public names (re)defined on added lines, including assignments, so a moved or rewritten definition is not a removal."""
    names = public_names(lang, lines)
    a = ASSIGN_RE[lang.name]
    names |= {m.group("name") for t in lines if (m := a.match(t))}
    return names


# ---------------------------------------------------------------- regions

BOUNDARY_RE = {
    "python": re.compile(r"^\s*(@|def |async def |class )|^\s*$"),
    "typescript": re.compile(r"^\s*(export\s|function\s|class\s|interface\s|type\s|enum\s|const\s|let\s|async\s+function|"
                             r"public\s|private\s|protected\s|static\s|@)|^\s*$"),
    "csharp": re.compile(r"^\s*(public\s|private\s|protected\s|internal\s|static\s|\[|namespace\s|class\s|struct\s|record\s)|^\s*$"),
}


def boundary_re(path: str) -> re.Pattern:
    lang = language_of(path)
    return BOUNDARY_RE[lang.name] if lang else BOUNDARY_RE["python"]


# ---------------------------------------------------------------- formatting proofs

_TS_TOKEN = re.compile(
    r"""(?P<ws>\s+)
      | (?P<comment>//[^\n]*|/\*.*?\*/)
      | (?P<str>"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)
      | (?P<tok>[A-Za-z_$][\w$]*|\d[\w.]*|===|!==|=>|\?\?=?|\?\.|\*\*=?|\.\.\.|<<=|>>>=?|>>=|&&=?|\|\|=?|[-+*/%&|^<>=!]=?|\+\+|--|[^\s])""",
    re.S | re.X,
)
_CS_TOKEN = re.compile(
    r"""(?P<ws>\s+)
      | (?P<comment>//[^\n]*|/\*.*?\*/)
      | (?P<str>\$?@"(?:""|[^"])*"|@?\$?"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])+'|\"\"\".*?\"\"\")
      | (?P<tok>[A-Za-z_@][\w]*|\d[\w.]*|\?\?=?|\?\.|=>|<<=?|>>=?|&&|\|\||[-+*/%&|^<>=!]=?|\+\+|--|::|[^\s])""",
    re.S | re.X,
)
_ASI = {"return", "throw", "break", "continue", "yield", "++", "--"}


def _tokens(src: str, pat: re.Pattern) -> list[tuple[str, bool]] | None:
    """(token, preceded by a line break) for every non-space, non-comment token; None if the text cannot be split."""
    out, pos, newline = [], 0, False
    while pos < len(src):
        m = pat.match(src, pos)
        if not m or m.end() == pos:
            return None
        kind = m.lastgroup
        if kind == "ws" or kind == "comment":
            newline = newline or "\n" in m.group()
        else:
            out.append((m.group(), newline))
            newline = False
        pos = m.end()
    return out


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant) \
                    and isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _py_dump(src: str, strip_docs: bool) -> str | None:
    try:
        t = ast.parse(src)
    except (SyntaxError, ValueError):
        return None
    if strip_docs:
        t = _strip_docstrings(t)
    return ast.dump(t, annotate_fields=False, include_attributes=False)


def formatting_proof(path: str, old_src: str, new_src: str) -> str | None:
    """'formatting' when old and new provably mean the same, 'docs' when only Python docstrings differ, else None."""
    lang = language_of(path)
    if lang is PYTHON:
        a, b = _py_dump(old_src, False), _py_dump(new_src, False)
        if a is None or b is None:
            return None
        if a == b:
            return "formatting"
        return "docs" if _py_dump(old_src, True) == _py_dump(new_src, True) else None
    if lang is None:
        return None
    pat = _TS_TOKEN if lang is TYPESCRIPT else _CS_TOKEN
    a, b = _tokens(old_src, pat), _tokens(new_src, pat)
    if a is None or b is None or [t for t, _ in a] != [t for t, _ in b]:
        return None
    if lang is TYPESCRIPT:
        # a line break that moved next to an ASI-sensitive token can change meaning
        for (ta, na), (_, nb), prev in zip(a, b, [("", False)] + a[:-1]):
            if na != nb and (ta in _ASI or prev[0] in _ASI):
                return None
    return "formatting"


def logic_density(lang: Language | None, changed: list[str]) -> int:
    pat = (lang or PYTHON).logic_re
    return sum(len(pat.findall(t)) for t in changed)
