import ast
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import calibration as C  # noqa: E402
import decoys as D  # noqa: E402
from bugcensus import judge as J  # noqa: E402

FIXED = '''def clamp(x, lo, hi):
    """Keep x inside [lo, hi]."""
    if x < lo:
        return lo
    if x > hi:
        return hi
    return x
'''


def test_edit_check_accepts_a_small_realistic_bug_and_rejects_the_rest():
    ok, _ = D._edit_ok(FIXED, FIXED.replace("if x > hi:", "if x >= hi:"))
    assert ok
    assert D._edit_ok(FIXED, FIXED)[1] == "unchanged"
    assert D._edit_ok(FIXED, FIXED.replace("def clamp", "def clip"))[1] == "functions renamed, added or removed"
    assert D._edit_ok(FIXED, FIXED.replace("return x", "return (x"))[1] == "does not parse"


def test_code_spans_skip_docstrings():
    spans = D.code_spans(FIXED)
    texts = [t for _, _, t in spans]
    assert "<" in texts and ">" in texts and "hi" in texts
    doc_start = FIXED.index('"""')
    assert not any(a <= doc_start < b for a, b, _ in spans)


def _fake_scores(code):
    """A pretend model: unsure between < and <=, and between hi and lo; confident elsewhere."""
    out = []
    for a, b, t in D.code_spans(code):
        alts = []
        if t == "<":
            alts = [("<=", 0.3), (">", 0.01)]
        elif t == ">":
            alts = [(">=", 0.25)]
        elif t == "hi":
            alts = [("lo", 0.08)]
        out.append((a, b, t, 0.7, alts))
    # a token inside the docstring the model is unsure about: must be ignored
    i = code.index("Keep")
    out.append((i, i + 4, "Keep", 0.2, [("Hold", 0.5)]))
    return out


def test_token_candidates_are_near_misses_in_code_only():
    cands = D.token_candidates(FIXED, _fake_scores(FIXED), per_bug=2)
    assert cands, "expected candidates"
    for c in cands:
        ast.parse(c["code"])
        assert "Hold" not in c["code"]
        assert 0.03 <= c["p_alt"] <= 0.6
    assert cands[0]["from"] == "<" and cands[0]["to"] == "<="          # preferred operator, most plausible
    assert all(c["to"] != ">" for c in cands)                          # 0.01 is below the near-miss band


def test_transplant_handles_multi_hunk_edits():
    buggy = FIXED.replace("    if x > hi:\n        return hi\n", "    if x >= hi:\n        return x\n")
    mutated = FIXED.replace("if x < lo:", "if x <= lo:").replace('"""Keep x inside [lo, hi]."""', '"""Keep x inside [lo, hi]."""\n    x = x')
    t = C._transplant(FIXED, buggy, mutated, 4)
    assert t is not None
    (fb, fl), (bb, bl) = t
    assert fb == mutated and "if x <= lo:" in bb and "if x >= hi:" in bb and "    x = x\n" in bb
    assert bb.splitlines()[bl - 1] == mutated.splitlines()[fl - 1]


def test_judge_sees_only_nearby_findings_and_the_right_hunk():
    fs = [{"start_line": 3, "end_line": 3, "explanation": "a"}, {"start_line": 40, "end_line": 41, "explanation": "far"},
          {"start_line": 1, "end_line": 30, "explanation": "too wide"}]
    assert [f["explanation"] for f in J.near(fs, [5])] == ["a"]
    copy = FIXED.replace("if x > hi:", "if x >= hi:")
    hunk = J.hunk_near(copy, FIXED, 5)
    assert "-    if x >= hi:" in hunk and "+    if x > hi:" in hunk
    prompt = J.render({"reviewed": copy, "lines": [5], "diff": hunk}, J.near(fs, [5]))
    assert "0. lines 3-3: a" in prompt and "far" not in prompt
    k = J.key("s", "v", "r", "t")
    assert k == J.key("s", "v", "r", "t") and k != J.key("s", "v", "r", "t", placebo=True)


def test_indented_methods_are_handled():
    method = "    def f(self, x):\n        if x < 1:\n            return 0\n        return x\n"
    ok, why = D._edit_ok(method, method.replace("x < 1", "x <= 1"))
    assert ok, why
    spans = D.code_spans(method)
    assert any(t == "<" and method[a:b] == "<" for a, b, t in spans)
    cands = D.token_candidates(method, [(a, b, t, 0.7, [("<=", 0.3)]) for a, b, t in spans if t == "<"], per_bug=1)
    assert cands and "x <= 1" in cands[0]["code"]
