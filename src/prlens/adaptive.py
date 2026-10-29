"""The skip threshold that keeps its promise when the code changes: adaptive conformal control.

A fixed threshold is calibrated on past PRs. When new PRs differ (a new repository, a new agent, a refactor wave)
its miss rate drifts. Here the threshold moves after every reviewed PR instead (Gibbs & Candès, "Adaptive
Conformal Inference Under Distribution Shift", NeurIPS 2021, applied to the threshold in log-odds space):

    theta_{t+1} = theta_t - eta * (err_t - alpha)        threshold_t = sigmoid(theta_t)

where err_t = 1 if a bug was later found in code that PR t skipped, else 0. A miss tightens the threshold by
eta*(1-alpha); a clean PR loosens it by eta*alpha. When the threshold is at or under FLOOR, nothing is skipped on
score, so that PR cannot miss.

Guarantee (deterministic: it holds for every sequence of PRs, drifting or even adversarial; no exchangeability):

    (1/T) * sum_t err_t  <=  alpha + (theta_1 - logit(FLOOR) + eta*(1-alpha)) / (eta * T)

Proof: at or under the floor err_t = 0, so theta rises; above it, one step lowers theta by at most eta*(1-alpha).
So theta never drops below logit(FLOOR) - eta*(1-alpha), and summing the updates telescopes:
eta * sum(err_t - alpha) = theta_1 - theta_{T+1} <= theta_1 - logit(FLOOR) + eta*(1-alpha).

Assumptions, stated in the product: the outcome of each PR is fed back before the next one is triaged, and the
no-model skips (formatting proven unchanged, docs, lock files, config) never hold a functional bug.

    prlens adapt              # replay the evaluation PRs: fixed vs adaptive threshold, in date order and under drift
"""
from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, field

import numpy as np

ALPHA = 0.2
ETA = 0.5
FLOOR = 0.005
WARM = 15


def logit(p: float) -> float:
    p = min(max(p, 1e-9), 1 - 1e-9)
    return math.log(p / (1 - p))


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def bound(n: int, theta1: float, alpha: float = ALPHA, eta: float = ETA, floor: float = FLOOR) -> float:
    """The guaranteed ceiling on the miss rate after n PRs (above alpha by a term that shrinks as 1/n)."""
    if n <= 0:
        return 1.0
    return min(1.0, alpha + (max(theta1, logit(floor)) - logit(floor) + eta * (1 - alpha)) / (eta * n))


@dataclass
class Adaptive:
    """Threshold state for one scope (a repository, a language)."""

    threshold0: float
    alpha: float = ALPHA
    eta: float = ETA
    floor: float = FLOOR
    theta: float = field(init=False)
    n: int = 0
    misses: int = 0

    def __post_init__(self) -> None:
        self.theta = logit(self.threshold0)

    @property
    def threshold(self) -> float:
        t = sigmoid(self.theta)
        return 0.0 if t <= self.floor else t  # at the floor nothing is skipped on score

    def update(self, missed: bool) -> None:
        self.theta -= self.eta * (float(missed) - self.alpha)
        self.n += 1
        self.misses += int(missed)

    def bound(self) -> float:
        return bound(self.n, logit(self.threshold0), self.alpha, self.eta, self.floor)


# ---------------------------------------------------------------- replay on the evaluation PRs


def _outcome(pr: dict, t: float) -> tuple[bool, int, int]:
    """(missed, lines read, lines) for one PR at threshold t; pr['units'] carry out-of-fold 'p' (see fit.cross_fit)."""
    review = [u for u in pr["units"] if not u["skip"] and (u["rules"] or u["p"] >= t)]
    return (not any(u["bug"] for u in review)), sum(u["added"] + u["removed"] for u in review), pr["lines"]


def replay(stream: list[dict], alpha: float = ALPHA, eta: float = ETA, warm: int = WARM) -> dict:
    """Both thresholds on the same stream: the fixed one is chosen on the first `warm` PRs and kept; the adaptive
    one starts there and updates after each PR. Returns the per-PR series the Evaluation tab draws."""
    from .fit import pick

    t0 = pick(stream[:warm], alpha) or 0.05
    ad = Adaptive(t0, alpha, eta)
    fixed_err, ad_err, thresholds = [], [], []
    read = {"fixed": 0, "adaptive": 0}
    total = 0
    for pr in stream[warm:]:
        m_f, r_f, tot = _outcome(pr, t0)
        thresholds.append(ad.threshold)
        m_a, r_a, _ = _outcome(pr, ad.threshold)
        ad.update(m_a)
        fixed_err.append(m_f)
        ad_err.append(m_a)
        read["fixed"] += r_f
        read["adaptive"] += r_a
        total += tot
    cum = lambda e: (np.cumsum(e) / np.arange(1, len(e) + 1)).round(4).tolist()  # noqa: E731
    n = len(ad_err)
    return {
        "warm": warm, "alpha": alpha, "eta": eta, "floor": FLOOR, "start_threshold": t0, "prs": n,
        "fixed": cum(fixed_err), "adaptive": cum(ad_err),
        "bound": [round(bound(i, logit(t0), alpha, eta), 4) for i in range(1, n + 1)],
        "threshold": [round(t, 5) for t in thresholds],
        "read_share": {k: round(v / max(1, total), 4) for k, v in read.items()},
        "missed": {"fixed": int(sum(fixed_err)), "adaptive": int(sum(ad_err))},
    }


def orders(prs: list[dict], seed: int = 0, n_random: int = 200) -> dict:
    """The replays the Evaluation tab shows: date order, a deliberate shift (easiest repos first, hardest last),
    and the spread over random orders (where a fixed threshold is safe but wastes the error budget)."""
    from .fit import pick

    t_all = pick(prs, ALPHA)
    rate = {r: float(np.mean([_outcome(p, t_all)[0] for p in prs if p["repo"] == r])) for r in {p["repo"] for p in prs}}
    by_date = sorted(prs, key=lambda p: p["date"])
    shifted = sorted(prs, key=lambda p: (rate[p["repo"]], p["date"]))
    rng = np.random.default_rng(seed)
    rand = {"fixed": [], "adaptive": [], "read_fixed": [], "read_adaptive": []}
    for _ in range(n_random):
        r = replay([prs[i] for i in rng.permutation(len(prs))])
        rand["fixed"].append(r["fixed"][-1])
        rand["adaptive"].append(r["adaptive"][-1])
        rand["read_fixed"].append(r["read_share"]["fixed"])
        rand["read_adaptive"].append(r["read_share"]["adaptive"])
    q = lambda xs, a: round(float(np.quantile(xs, a)), 4)  # noqa: E731
    return {
        "date": replay(by_date),
        "shift": replay(shifted),
        "random": {k: {"mean": round(float(np.mean(v)), 4), "p90": q(v, 0.9)} for k, v in rand.items()},
    }


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    args = ap.parse_args(argv)
    from .fit import cross_fit, load

    prs = load(args.model)
    cross_fit(prs)
    o = orders(prs)
    for name in ("date", "shift"):
        r = o[name]
        print(f"{'date order' if name == 'date' else 'hardest repos last':20s} fixed: missed {r['missed']['fixed']}/{r['prs']} "
              f"({r['fixed'][-1]:.0%}), read {r['read_share']['fixed']:.0%} | adaptive: missed {r['missed']['adaptive']}/{r['prs']} "
              f"({r['adaptive'][-1]:.0%}), read {r['read_share']['adaptive']:.0%} | guaranteed <= {r['bound'][-1]:.0%}")
    rr = o["random"]
    print(f"random orders        fixed: {rr['fixed']['mean']:.0%} (worst 10%: {rr['fixed']['p90']:.0%}), read {rr['read_fixed']['mean']:.0%}"
          f" | adaptive: {rr['adaptive']['mean']:.0%} (worst 10%: {rr['adaptive']['p90']:.0%}), read {rr['read_adaptive']['mean']:.0%}")
