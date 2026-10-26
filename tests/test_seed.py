import ast
from pathlib import Path

from bugcensus.seed import (apply_decoys, behavior_differs, candidate_decoys, make_copies,
                            valid_decoys)

EXAMPLE = (Path(__file__).parent.parent / "examples" / "billing.py").read_text()


def test_every_candidate_parses():
    for d in candidate_decoys(EXAMPLE):
        ast.parse(apply_decoys(EXAMPLE, [d]))


def test_decoy_preserves_formatting_and_comments():
    d = next(d for d in candidate_decoys(EXAMPLE) if d.kind == "boundary" and d.function == "apply_discount")
    out = apply_decoys(EXAMPLE, [d])
    changed = [(a, b) for a, b in zip(EXAMPLE.splitlines(), out.splitlines()) if a != b]
    assert len(changed) == 1                      # exactly one line differs
    assert "# known real bug" in out              # comments survive
    assert len(out.splitlines()) == len(EXAMPLE.splitlines())


def test_equivalent_mutant_is_rejected():
    src = "def f(x):\n    y = x + 0\n    return x\n"
    d = next(d for d in candidate_decoys(src) if d.kind == "operator")   # x + 0 -> x - 0, y unused
    assert not behavior_differs(src, apply_decoys(src, [d]), "f")


def test_boundary_shift_changes_behavior():
    src = "def f(x):\n    if x > 100:\n        raise ValueError\n    return x\n"
    d = next(d for d in candidate_decoys(src) if d.kind == "boundary")
    assert behavior_differs(src, apply_decoys(src, [d]), "f")


def test_valid_decoys_and_copies():
    decoys = valid_decoys(EXAMPLE)
    assert len(decoys) >= 6
    kinds = {d.kind for d in decoys}
    assert {"boundary", "missing_guard"} & kinds
    copies = make_copies(EXAMPLE, decoys, n_copies=2, per_copy=5)
    assert len(copies) == 2
    for c in copies:
        ast.parse(c.source)
        assert len({d.function for d in c.decoys}) == len(c.decoys)   # one per function
        lines = c.source.splitlines()
        for d in c.decoys:
            if d.replacement:
                assert d.mutated_text in lines[d.final_line - 1]
    # different copies use different decoys
    a = {(d.function, d.start, d.kind, d.replacement) for d in copies[0].decoys}
    b = {(d.function, d.start, d.kind, d.replacement) for d in copies[1].decoys}
    assert not (a & b)


def test_line_ranges_restrict_placement():
    decoys = valid_decoys(EXAMPLE, line_ranges=[(10, 16)])
    assert decoys and all(d.function == "clamp" for d in decoys)


def test_missing_guard_line_numbers_shift_correctly():
    src = ("def a(x):\n    if x is None:\n        return 0\n    return x + 1\n\n"
           "def b(y):\n    return y > 3\n")
    ds = candidate_decoys(src)
    guard = next(d for d in ds if d.kind == "missing_guard")
    boundary = next(d for d in ds if d.kind == "boundary" and d.function == "b")
    out = apply_decoys(src, [guard, boundary])
    assert out.splitlines()[boundary.final_line - 1].strip() == "return y >= 3"
