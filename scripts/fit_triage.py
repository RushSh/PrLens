"""Fit the triage combiner and find the skip threshold, on the traced PRs and Spark Open region scores.

    python scripts/fit_triage.py                 # cross-fitted by repo: gate numbers, skip threshold, held-out check
    python scripts/fit_triage.py --save          # also fit on everything and write data/triage/combiner.json

Combiner: logistic regression (small L2) on model risk (as log-odds), logic density, test file, region size and
must-review rule. Every number printed is out-of-fold: a repo is never scored by a fit that saw it.

Skip threshold: regions below it are skipped (must-review regions never are). A PR counts as missed when none of
its bug regions is left in the review list. The threshold is the lowest-reading one whose 90% upper bound on the
miss rate (Clopper-Pearson) stays within --alpha. "Held out" picks the threshold without the repo being judged.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from scipy.stats import beta

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from trace_prs import OUT as PRS, is_test, logic_density, read_until  # noqa: E402

FEATURES = ["model log-odds", "log logic", "test file", "log size", "must-review rule"]


def load(model: str):
    sc = {}
    for l in open(ROOT / "data" / "triage" / "scores" / f"{model}.jsonl"):
        x = json.loads(l)
        if x["risk"] is not None:
            sc[x["region"]] = x["risk"]
    prs = [json.loads(l) for l in open(PRS)]
    for p in prs:
        p["units"] = []
        for h in p["hunks"]:
            for g in h["regions"]:
                lines = [l for l in h["lines"] if l[2] in g["new_lines"]]
                u = dict(g, file=h["file"], skip=h["skip"], lines=lines, rules=g["rules"],
                         risk=sc.get(f"{p['pr_id']}|{g['id']}"))
                p["units"].append(u)
    return prs


def feats(u) -> list[float]:
    r = min(max(u["risk"] if u["risk"] is not None else 0.05, 0.01), 0.99)
    return [math.log(r / (1 - r)), math.log1p(logic_density(u)), float(is_test(u)),
            math.log1p(u["added"] + u["removed"]), float(bool(u["rules"]))]


def fit(X: np.ndarray, y: np.ndarray, l2: float = 1.0):
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = np.hstack([np.ones((len(X), 1)), (X - mu) / sd])

    def nll(w):
        z = Z @ w
        return np.sum(np.logaddexp(0, z) - y * z) + l2 * np.sum(w[1:] ** 2)

    def grad(w):
        p = 1 / (1 + np.exp(-(Z @ w)))
        g = Z.T @ (p - y)
        g[1:] += 2 * l2 * w[1:]
        return g

    w = minimize(nll, np.zeros(Z.shape[1]), jac=grad, method="L-BFGS-B").x
    return {"mu": mu.tolist(), "sd": sd.tolist(), "w": w.tolist()}


def predict(m, X: np.ndarray) -> np.ndarray:
    Z = np.hstack([np.ones((len(X), 1)), (X - np.array(m["mu"])) / np.array(m["sd"])])
    return 1 / (1 + np.exp(-(Z @ np.array(m["w"]))))


def ucb(k: int, n: int, conf: float = 0.9) -> float:
    return 1.0 if k >= n else float(beta.ppf(conf, k + 1, n - k))


def skip_outcome(prs, t: float):
    """(misses, lines read, total lines, per-PR read shares) when regions scored below t are skipped."""
    miss, read, tot, shares = 0, 0, 0, []
    for p in prs:
        review = [u for u in p["units"] if not u["skip"] and (u["rules"] or u["p"] >= t)]
        r = sum(u["added"] + u["removed"] for u in review)
        read += r
        tot += p["lines"]
        shares.append(r / max(1, p["lines"]))
        if not any(u["bug"] for u in review):
            miss += 1
    return miss, read, tot, shares


def pick(prs, alpha: float) -> float:
    ts = sorted({u["p"] for p in prs for u in p["units"] if not u["skip"]}, reverse=True)
    best = 0.0
    for t in ts:  # highest threshold (least reading) whose bound still holds
        k, *_ = skip_outcome(prs, t)
        if ucb(k, len(prs)) <= alpha:
            return t
    return best


def cross_fit(prs) -> tuple[list, np.ndarray, np.ndarray]:
    """Give every region an out-of-fold bug probability u["p"] (fit without its repo); returns (units, X, y)."""
    repos = sorted({p["repo"] for p in prs})
    units = [(p, u) for p in prs for u in p["units"] if not u["skip"]]
    X = np.array([feats(u) for _, u in units])
    y = np.array([float(u["bug"]) for _, u in units])
    for repo in repos:
        tr = np.array([p["repo"] != repo for p, _ in units])
        m = fit(X[tr], y[tr])
        for (p, u), pv in zip([x for x, keep in zip(units, ~tr) if keep], predict(m, X[~tr])):
            u["p"] = float(pv)
    for p in prs:
        for u in p["units"]:
            u.setdefault("p", 0.0)
    return units, X, y


def held_out(prs, alpha: float) -> tuple[int, int, int]:
    """Choose the threshold without each repo, apply it to that repo: (missed PRs, lines read, total lines)."""
    hk = hr = ht = 0
    for repo in sorted({p["repo"] for p in prs}):
        rest = [p for p in prs if p["repo"] != repo]
        mine = [p for p in prs if p["repo"] == repo]
        k, r, tot, _ = skip_outcome(mine, pick(rest, alpha))
        hk, hr, ht = hk + k, hr + r, ht + tot
    return hk, hr, ht


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--alpha", type=float, default=0.2, help="miss-rate bound (90%% confidence)")
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args()
    prs = load(args.model)
    repos = sorted({p["repo"] for p in prs})
    units, X, y = cross_fit(prs)
    pos = [u["p"] for _, u in units if u["bug"]]
    neg = [u["p"] for _, u in units if not u["bug"]]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
    raw = [u["risk"] or 0 for _, u in units if u["bug"]], [u["risk"] or 0 for _, u in units if not u["bug"]]
    auc_raw = sum((a > b) + 0.5 * (a == b) for a in raw[0] for b in raw[1]) / (len(raw[0]) * len(raw[1]))
    print(f"{len(prs)} PRs, {len(units)} scored regions ({int(y.sum())} with a bug), {len(repos)} repos")
    print(f"region AUC out of fold: combiner {auc:.2f}  vs Spark Open alone {auc_raw:.2f}")
    print("\nGate (bug in what you read, by combiner order):")
    for frac in (1 / 4, 1 / 3, 1 / 2):
        hits = sum(read_until(p["units"], sorted([u for u in p["units"] if not u["skip"]], key=lambda u: -u["p"]),
                              frac * p["lines"]) for p in prs)
        print(f"  reading {frac:.0%} of lines: {hits}/{len(prs)} = {hits / len(prs):.0%}")

    print(f"\nSkip threshold sweep (all {len(prs)} PRs, out-of-fold scores):")
    print(f"  {'threshold':>9s} {'missed PRs':>11s} {'90% bound':>10s} {'lines read':>11s} {'median PR':>10s}")
    for t in (0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.3):
        k, r, tot, sh = skip_outcome(prs, t)
        print(f"  {t:9.2f} {k:5d}/{len(prs):<5d} {ucb(k, len(prs)):10.0%} {r / tot:11.0%} {float(np.median(sh)):10.0%}")
    t = pick(prs, args.alpha)
    k, r, tot, sh = skip_outcome(prs, t)
    print(f"\nThreshold for a {args.alpha:.0%} bound: {t:.3f} -> {k} missed, bound {ucb(k, len(prs)):.0%}, "
          f"read {r / tot:.0%} of lines (median PR {float(np.median(sh)):.0%})")

    # honest check: choose the threshold without the repo being judged
    hk, hr, ht = held_out(prs, args.alpha)
    print(f"Held out by repo: {hk}/{len(prs)} missed ({hk / len(prs):.0%}), read {hr / ht:.0%} of lines")

    if args.save:
        m = fit(X, y)
        m.update(features=FEATURES, model=args.model, threshold=t, alpha=args.alpha, prs=len(prs),
                 note="fit on all traced PRs; threshold from out-of-fold scores")
        out = ROOT / "data" / "triage" / "combiner.json"
        out.write_text(json.dumps(m, indent=2))
        print(f"wrote {out.relative_to(ROOT)}; weights {dict(zip(['bias'] + FEATURES, [round(w, 2) for w in m['w']]))}")


if __name__ == "__main__":
    main()
