import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import calibration as C  # noqa: E402

FIXED = "def f(x, lo, hi):\n    if x < lo:\n        return lo\n    if x > hi:\n        return hi\n    return x\n"
BUGGY = "def f(x, lo, hi):\n    if x < lo:\n        return lo\n    if x >= hi:\n        return x\n    return x\n"
# decoy validated on FIXED: `x < lo` -> `x <= lo` (line 2), away from the fix (lines 4-5)
DECOY = FIXED.replace("if x < lo", "if x <= lo")


def test_transplant_applies_the_same_edit_to_both_versions():
    (fb, fl), (bb, bl) = C._transplant(FIXED, BUGGY, DECOY, 2)
    assert fb == DECOY and fl == 2
    assert bb == BUGGY.replace("if x < lo", "if x <= lo") and bl == 2


def test_transplant_refuses_decoys_on_lines_that_differ_between_versions():
    on_fix = FIXED.replace("if x > hi", "if x < hi")          # edits a line the fix changed
    assert C._transplant(FIXED, BUGGY, on_fix, 4) is None


def _unit():
    group = [{"bug_id": f"r@{i}", "file": f"m{i}.py", "fixed": FIXED, "buggy": BUGGY, "real_lines": [4, 5],
              "menu": [{"family": "boundary", "desc": "d", "fixed": {"block": DECOY, "line": 2},
                        "buggy": {"block": BUGGY.replace("if x < lo", "if x <= lo"), "line": 2}}]} for i in range(3)]
    return C._build_unit("cal-r-0-0", "r", group, {1}, 1)


def test_unit_knows_its_real_bugs_and_copies_skip_flagged_lines():
    u = _unit()
    assert u["k"] == 1 and [b["form"] for b in u["blocks"]] == ["fixed", "buggy", "fixed"]
    real = u["blocks"][1]["real_lines"]
    assert [u["original"].splitlines()[ln - 1] for ln in real] == ["    if x >= hi:", "        return x"]
    copies = C.build_copies(u, flagged=set())
    assert len(copies) == 1 and len(copies[0]["decoys"]) == 3        # one menu decoy per function
    for d in copies[0]["decoys"]:
        assert "<= lo" in copies[0]["text"].splitlines()[d["line"] - 1]
    first = u["blocks"][0]["start"] + 1                               # decoy line of block 0, flagged
    assert len(C.build_copies(u, flagged={first})[0]["decoys"]) == 2
