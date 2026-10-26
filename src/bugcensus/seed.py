"""Decoy seeding: plant realistic, behavior-changing bugs in throwaway copies of the code.

Day-1 families (classic, rule-based): boundary shifts, operator swaps, operand swaps,
and/or swaps, dropped negations, off-by-one constants, dropped guard clauses.
Model-native decoys (Glimmer / Spark Open token probabilities) and the newer families
(divergent reimplementation, incomplete propagation, spec misread) come later in the week.

Edits are spliced into the ORIGINAL text, so formatting and comments are preserved and
nothing visually marks a decoy. The user's repository is never touched: callers work on
strings or on temporary copies.
"""
from __future__ import annotations

import ast
import copy
import itertools
import random
import shutil
import signal
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------- data types


@dataclass
class Decoy:
    kind: str
    function: str
    line: int              # 1-based line in the ORIGINAL source
    start: int             # byte offsets in the original source
    end: int
    replacement: bytes
    original_text: str
    mutated_text: str
    lines_removed: int = 0
    final_line: int | None = None   # line in the seeded copy (set when applied)

    def describe(self) -> str:
        o = " ".join(self.original_text.split())
        m = " ".join(self.mutated_text.split())
        return f"{self.kind} in {self.function}() line {self.line}: `{o}` -> `{m}`"


@dataclass
class SeededCopy:
    name: str
    source: str
    decoys: list[Decoy] = field(default_factory=list)


# --------------------------------------------------------------------------- offsets


class _Offsets:
    """Convert ast (line, col) positions to byte offsets. ast col offsets are UTF-8 byte offsets."""

    def __init__(self, source: str):
        self.data = source.encode()
        self.line_starts = [0]
        for i, b in enumerate(self.data):
            if b == 0x0A:
                self.line_starts.append(i + 1)

    def at(self, line: int, col: int) -> int:
        return self.line_starts[line - 1] + col

    def start(self, node: ast.AST) -> int:
        return self.at(node.lineno, node.col_offset)

    def end(self, node: ast.AST) -> int:
        return self.at(node.end_lineno, node.end_col_offset)


_CMP_SWAP = {ast.Lt: ("<", "<="), ast.LtE: ("<=", "<"), ast.Gt: (">", ">="), ast.GtE: (">=", ">")}
_BIN_SWAP = {ast.Add: ("+", "-"), ast.Sub: ("-", "+"), ast.FloorDiv: ("//", "/"), ast.Div: ("/", "//")}
_NONCOMMUTATIVE = (ast.Sub, ast.Div, ast.FloorDiv, ast.Mod)


def _find_token(seg: bytes, token: bytes) -> int:
    """Index of `token` in seg as an operator (not part of a longer operator)."""
    ops = b"<>=!+-*/%"
    i = seg.find(token)
    while i != -1:
        before = seg[i - 1:i] if i > 0 else b""
        after = seg[i + len(token):i + len(token) + 1]
        if (not before or before not in ops) and (not after or after not in ops):
            return i
        i = seg.find(token, i + 1)
    return -1


def _functions(tree: ast.AST):
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node


def _in_ranges(line: int, ranges: list[tuple[int, int]] | None) -> bool:
    return ranges is None or any(a <= line <= b for a, b in ranges)


# --------------------------------------------------------------------------- candidates


def candidate_decoys(source: str, line_ranges: list[tuple[int, int]] | None = None) -> list[Decoy]:
    """All syntactically valid single-edit decoys inside functions within line_ranges."""
    tree = ast.parse(source)
    off = _Offsets(source)
    data = off.data
    out: list[Decoy] = []

    def add(kind, fn, node_line, start, end, repl: bytes, removed=0):
        orig = data[start:end].decode(errors="replace")
        mutated = (data[:start] + repl + data[end:]).decode()
        try:
            ast.parse(mutated)
        except SyntaxError:
            return
        out.append(Decoy(kind, fn.name, node_line, start, end, repl, orig.strip(),
                         repl.decode().strip() or "<removed>", removed))

    for fn in _functions(tree):
        body_nodes = [n for stmt in fn.body for n in ast.walk(stmt)]
        for node in body_nodes:
            line = getattr(node, "lineno", None)
            if line is None or not _in_ranges(line, line_ranges):
                continue
            # boundary shift: a < b  ->  a <= b
            if isinstance(node, ast.Compare) and len(node.ops) == 1 and type(node.ops[0]) in _CMP_SWAP:
                old, new = _CMP_SWAP[type(node.ops[0])]
                s, e = off.end(node.left), off.start(node.comparators[0])
                i = _find_token(data[s:e], old.encode())
                if i >= 0:
                    add("boundary", fn, line, s + i, s + i + len(old), new.encode())
            # operator swap / operand swap
            if isinstance(node, ast.BinOp):
                s, e = off.end(node.left), off.start(node.right)
                if type(node.op) in _BIN_SWAP:
                    old, new = _BIN_SWAP[type(node.op)]
                    i = _find_token(data[s:e], old.encode())
                    if i >= 0:
                        add("operator", fn, line, s + i, s + i + len(old), new.encode())
                if isinstance(node.op, _NONCOMMUTATIVE) and node.left.lineno == node.right.end_lineno:
                    ls, le = off.start(node.left), off.end(node.left)
                    rs, re_ = off.start(node.right), off.end(node.right)
                    swapped = data[rs:re_] + data[le:rs] + data[ls:le]
                    add("operand_swap", fn, line, ls, re_, swapped)
            # and <-> or
            if isinstance(node, ast.BoolOp) and len(node.values) == 2:
                s, e = off.end(node.values[0]), off.start(node.values[1])
                old = b"and" if isinstance(node.op, ast.And) else b"or"
                new = b"or" if old == b"and" else b"and"
                i = data[s:e].find(old)
                if i >= 0:
                    add("logic", fn, line, s + i, s + i + len(old), new)
            # drop a negation: not x -> x
            if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
                add("negation", fn, line, off.start(node), off.start(node.operand), b"")
            # off-by-one integer constant (skip booleans)
            if isinstance(node, ast.Constant) and type(node.value) is int:
                for delta in (1, -1):
                    v = node.value + delta
                    add("off_by_one", fn, line, off.start(node), off.end(node), str(v).encode())
        # dropped guard clause: `if cond: return/raise/continue` with no else
        for stmt in ast.walk(fn):
            if (isinstance(stmt, ast.If) and not stmt.orelse and len(stmt.body) == 1
                    and isinstance(stmt.body[0], (ast.Return, ast.Raise, ast.Continue))
                    and _in_ranges(stmt.lineno, line_ranges)):
                s = off.at(stmt.lineno, 0)
                e = off.line_starts[stmt.end_lineno] if stmt.end_lineno < len(off.line_starts) else len(data)
                add("missing_guard", fn, stmt.lineno, s, e, b"",
                    removed=stmt.end_lineno - stmt.lineno + 1)
    return out


# --------------------------------------------------------------------------- behavior check


class _Timeout(Exception):
    pass


def _alarm(signum, frame):
    raise _Timeout()


def _load(source: str, func: str):
    ns: dict = {"__name__": "bugcensus_probe"}
    exec(compile(source, "<probe>", "exec"), ns)
    return ns[func]


def _outcome(fn, args, timeout=0.2):
    old = signal.signal(signal.SIGALRM, _alarm)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    try:
        value = fn(*copy.deepcopy(args))
        return ("ok", repr(value))
    except _Timeout:
        return ("timeout", "")
    except Exception as exc:  # the exception type is part of the behavior
        return ("raise", type(exc).__name__)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


_POOL = [0, 1, -1, 2, 3, 10, 100, 0.5, 2.5, -3.5, "", "a", "abc", "a b", [], [1], [1, 2, 3], [3, 1, 2],
         [0, 0], {"a": 1}, None, True, False]


def generate_inputs(source: str, func: str, n: int = 300, seed: int = 0) -> list[tuple]:
    """Type-agnostic input pool: generic values plus constants found in the function (and +-1)."""
    tree = ast.parse(source)
    fn = next(f for f in _functions(tree) if f.name == func)
    nargs = len(fn.args.posonlyargs) + len(fn.args.args)
    if nargs and fn.args.args and fn.args.args[0].arg in ("self", "cls"):
        return []  # methods need an instance; handled by tests-based checks instead
    consts = {c.value for c in ast.walk(fn) if isinstance(c, ast.Constant)
              and type(c.value) in (int, float) and not isinstance(c.value, bool)}
    pool = list(_POOL) + [v + d for v in consts for d in (-1, 0, 1)]
    rng = random.Random(seed)
    if nargs == 0:
        return [()]
    combos = list(itertools.islice(itertools.product(pool, repeat=nargs), 5000)) if nargs <= 2 else []
    if len(combos) < n:
        combos += [tuple(rng.choice(pool) for _ in range(nargs)) for _ in range(n)]
    rng.shuffle(combos)
    return combos[:n]


def behavior_differs(original: str, mutated: str, func: str, inputs: list[tuple] | None = None) -> bool:
    """True if some input gives a different result or exception. Equivalent mutants are not bugs."""
    try:
        f0, f1 = _load(original, func), _load(mutated, func)
    except Exception:
        return False
    inputs = inputs if inputs is not None else generate_inputs(original, func)
    informative = False
    for args in inputs:
        a, b = _outcome(f0, args), _outcome(f1, args)
        if a[0] == "raise" and a[1] == "TypeError" and b == a:
            continue
        informative = True
        if a != b:
            return True
    return False


def escapes_tests(repo_dir: Path, rel_path: str, mutated_source: str, test_cmd: list[str],
                  timeout: int = 300) -> bool:
    """True if the repo's tests still PASS with the decoy applied (in a temporary copy).
    A decoy the tests already catch says nothing about what review misses."""
    with tempfile.TemporaryDirectory(prefix="bugcensus-") as tmp:
        work = Path(tmp) / "repo"
        shutil.copytree(repo_dir, work, ignore=shutil.ignore_patterns(".git", ".venv", "node_modules"))
        (work / rel_path).write_text(mutated_source)
        try:
            proc = subprocess.run(test_cmd, cwd=work, capture_output=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return False
        return proc.returncode == 0


# --------------------------------------------------------------------------- copies


def apply_decoys(source: str, decoys: list[Decoy]) -> str:
    """Apply non-overlapping decoys (bottom-up) and set each decoy's final_line."""
    data = source.encode()
    for d in sorted(decoys, key=lambda d: d.start, reverse=True):
        data = data[:d.start] + d.replacement + data[d.end:]
    for d in decoys:
        shift = sum(o.lines_removed for o in decoys if o.start < d.start)
        d.final_line = d.line - shift
    return data.decode()


def valid_decoys(source: str, line_ranges=None, inputs_by_func: dict[str, list[tuple]] | None = None,
                 max_per_func: int = 6, seed: int = 0) -> list[Decoy]:
    """Candidates that parse AND change behavior on generated (or supplied) inputs."""
    rng = random.Random(seed)
    cands = candidate_decoys(source, line_ranges)
    rng.shuffle(cands)
    kept, per_func = [], {}
    for d in cands:
        if per_func.get(d.function, 0) >= max_per_func:
            continue
        mutated = apply_decoys(source, [copy.copy(d)])
        inputs = (inputs_by_func or {}).get(d.function)
        if behavior_differs(source, mutated, d.function, inputs):
            kept.append(d)
            per_func[d.function] = per_func.get(d.function, 0) + 1
    return kept


def make_copies(source: str, decoys: list[Decoy], n_copies: int = 2, per_copy: int = 5,
                seed: int = 0) -> list[SeededCopy]:
    """Build copies with at most one decoy per function and up to `per_copy` decoys each.
    Different copies use different decoys."""
    rng = random.Random(seed)
    pool = list(decoys)
    rng.shuffle(pool)
    copies = []
    used_kinds: dict[str, int] = {}
    for i in range(n_copies):
        chosen, funcs = [], set()
        while len(chosen) < per_copy:
            options = [d for d in pool if d.function not in funcs]
            if not options:
                break
            # rotate through decoy families so no single kind (e.g. off-by-one) dominates
            d = min(options, key=lambda x: used_kinds.get(x.kind, 0))
            chosen.append(copy.copy(d))
            funcs.add(d.function)
            used_kinds[d.kind] = used_kinds.get(d.kind, 0) + 1
            pool.remove(d)
        if not chosen:
            break
        copies.append(SeededCopy(f"copy-{chr(65 + i)}", apply_decoys(source, chosen), chosen))
    return copies
