import math
import random

from prlens.adaptive import FLOOR, Adaptive, bound, logit, replay


def test_a_miss_tightens_and_a_clean_pr_loosens():
    a = Adaptive(0.06)
    t0 = a.threshold
    a.update(True)
    assert a.threshold < t0
    t1 = a.threshold
    a.update(False)
    assert t1 < a.threshold < t0


def test_at_the_floor_nothing_is_skipped():
    a = Adaptive(0.06)
    for _ in range(30):
        a.update(True)
    assert a.threshold == 0.0


def test_the_guarantee_holds_against_an_adversary():
    # the worst case: every PR whose threshold is above the floor turns out to hide a bug in skipped code
    for theta_start in (0.01, 0.06, 0.3):
        a = Adaptive(theta_start)
        for t in range(1, 2001):
            a.update(a.threshold > 0.0)
            assert a.misses / a.n <= a.bound() + 1e-12, (theta_start, t)
    assert abs(a.misses / a.n - a.alpha) < 0.01  # and the long-run rate settles at alpha


def test_the_guarantee_holds_on_random_sequences():
    rng = random.Random(0)
    for _ in range(50):
        a = Adaptive(rng.uniform(0.01, 0.3))
        p_miss = rng.uniform(0, 1)
        for _ in range(300):
            a.update(a.threshold > 0.0 and rng.random() < p_miss)
            assert a.misses / a.n <= a.bound() + 1e-12


def test_bound_shrinks_like_one_over_n():
    b10, b100 = bound(10, logit(0.06)), bound(100, logit(0.06))
    assert b10 > b100 > 0.2
    assert math.isclose((b10 - 0.2) / (b100 - 0.2), 10, rel_tol=1e-9)


def _pr(repo, date, p_bug, p_other=0.01):
    units = [
        {"skip": None, "rules": [], "p": p_bug, "bug": True, "added": 5, "removed": 0},
        {"skip": None, "rules": [], "p": p_other, "bug": False, "added": 20, "removed": 0},
    ]
    return {"repo": repo, "date": date, "lines": 25, "units": units}


def test_replay_reports_both_thresholds_on_the_same_stream():
    rng = random.Random(1)
    prs = [_pr("easy", f"2026-01-{i % 28 + 1:02d}", rng.uniform(0.2, 0.9)) for i in range(20)]
    prs += [_pr("hard", f"2026-02-{i % 28 + 1:02d}", rng.uniform(0.01, 0.08)) for i in range(40)]  # drift: bugs look safe
    r = replay(prs, warm=15)
    assert r["prs"] == 45 and len(r["fixed"]) == len(r["adaptive"]) == len(r["bound"]) == 45
    assert r["adaptive"][-1] <= r["bound"][-1] + 1e-12
    assert r["adaptive"][-1] < r["fixed"][-1]  # under drift the adaptive threshold misses less
    assert FLOOR < 0.01
