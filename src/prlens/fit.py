"""Fit the triage combiner and find the skip threshold, on the traced PRs and Spark Open region scores.

    prlens fit                 # cross-fitted by repo: gate numbers, skip threshold, held-out check
    prlens fit --save          # also fit on everything and write data/triage/combiner.json

Combiner: logistic regression (small L2) on model risk (as log-odds), logic density, test file and region size.
Fit spec (fixed in advance, Proposal v4): the combiner is fit only on the regions it actually scores; must-review
regions are always read, so they leave the fit (they still get an out-of-fold score, for ordering and display).
`--spec with-must-review` is the earlier spec (those regions in the fit, plus a must-review feature), kept for the
ablation only. Every number printed is out-of-fold: a repo is never scored by a fit that saw it.

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

from .bugdata import ROOT
from .trace import OUT as PRS, is_test, logic_density, read_until

FEATURES = ["model log-odds", "log logic", "test file", "log size"]
SPECS = {"scored-only": FEATURES, "with-must-review": FEATURES + ["must-review rule"]}


def load(model: str, language: str | None = "python"):
    """Traced PRs with their region scores; `language` keeps only that language's PRs (None: all)."""
    sc = {}
    for l in open(ROOT / "data" / "triage" / "scores" / f"{model}.jsonl"):
        x = json.loads(l)
        if x["risk"] is not None:
            sc[x["region"]] = x["risk"]
    prs = [json.loads(l) for l in open(PRS)]
    if language:
        prs = [p for p in prs if p.get("language", "python") == language]
    for p in prs:
        p["units"] = []
        for h in p["hunks"]:
            for g in h["regions"]:
                lines = [l for l in h["lines"] if l[2] in g["new_lines"]]
                u = dict(g, file=h["file"], skip=h["skip"], lines=lines, rules=g["rules"],
                         risk=sc.get(f"{p['pr_id']}|{g['id']}"))
                p["units"].append(u)
    return prs


def scored(u) -> bool:
    """A region the combiner can judge. One with no model score (a failed call) is always read and never fit on,
    in evaluation and live triage alike."""
    return not u["skip"] and u["risk"] is not None


def feats(u, spec: str = "scored-only") -> list[float]:
    if u["risk"] is None:
        raise ValueError(f"region {u.get('id')} has no model score: it is read, not scored by the combiner")
    r = min(max(u["risk"], 0.01), 0.99)
    return [math.log(r / (1 - r)), math.log1p(logic_density(u)), float(is_test(u)),
            math.log1p(u["added"] + u["removed"])] + ([float(bool(u["rules"]))] if spec == "with-must-review" else [])


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


def cross_fit(prs, spec: str = "scored-only") -> tuple[list, np.ndarray, np.ndarray]:
    """Give every scored region an out-of-fold risk score u["p"] (fit without its repo); returns the fit set
    (units, X, y). Under "scored-only" must-review regions are scored but never fit on."""
    repos = sorted({p["repo"] for p in prs})
    scored_units = [(p, u) for p in prs for u in p["units"] if scored(u)]
    train = [(p, u) for p, u in scored_units if spec == "with-must-review" or not u["rules"]]
    X = np.array([feats(u, spec) for _, u in train])
    y = np.array([float(u["bug"]) for _, u in train])
    for repo in repos:
        tr = np.array([p["repo"] != repo for p, _ in train])
        m = fit(X[tr], y[tr])
        mine = [u for p, u in scored_units if p["repo"] == repo]
        if mine:
            for u, pv in zip(mine, predict(m, np.array([feats(u, spec) for u in mine]))):
                u["p"] = float(pv)
    for p in prs:
        for u in p["units"]:
            if not u["skip"] and u["risk"] is None:
                u["p"] = 1.0  # unscored: always read
            u.setdefault("p", 0.0)
    return train, X, y


def held_out(prs, alpha: float) -> tuple[int, int, int]:
    """Choose the threshold without each repo, apply it to that repo: (missed PRs, lines read, total lines)."""
    hk = hr = ht = 0
    for repo in sorted({p["repo"] for p in prs}):
        rest = [p for p in prs if p["repo"] != repo]
        mine = [p for p in prs if p["repo"] == repo]
        k, r, tot, _ = skip_outcome(mine, pick(rest, alpha))
        hk, hr, ht = hk + k, hr + r, ht + tot
    return hk, hr, ht


def combiner_path(language: str) -> Path:
    """Python keeps the original file name; other languages get their own."""
    name = "combiner.json" if language == "python" else f"combiner_{language}.json"
    return ROOT / "data" / "triage" / name


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--alpha", type=float, default=0.2, help="miss-rate bound (90%% confidence)")
    ap.add_argument("--save", action="store_true")
    ap.add_argument("--language", default="python", help="python, typescript or csharp: each is calibrated on its own")
    ap.add_argument("--spec", choices=sorted(SPECS), default="scored-only",
                    help="fit spec (default: the fixed v4 spec; with-must-review is for the ablation only)")
    args = ap.parse_args(argv)
    prs = load(args.model, args.language)
    if len(prs) < 20:
        raise SystemExit(f"only {len(prs)} {args.language} PRs with scores; need at least 20 to calibrate")
    repos = sorted({p["repo"] for p in prs})
    units, X, y = cross_fit(prs, args.spec)
    pos = [u["p"] for _, u in units if u["bug"]]
    neg = [u["p"] for _, u in units if not u["bug"]]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
    raw = [u["risk"] for _, u in units if u["bug"]], [u["risk"] for _, u in units if not u["bug"]]
    unscored = sum(1 for p in prs for u in p["units"] if not u["skip"] and u["risk"] is None)
    if unscored:
        print(f"{unscored} regions have no model score: always read, left out of the fit")
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
        if args.spec != "scored-only":
            raise SystemExit("only the fixed spec (scored-only) is saved; other specs are for comparison")
        m.update(features=SPECS[args.spec], spec=args.spec, model=args.model, threshold=t, alpha=args.alpha, prs=len(prs), language=args.language,
                 note="fit on all traced PRs of this language; threshold from out-of-fold scores")
        out = combiner_path(args.language)
        out.write_text(json.dumps(m, indent=2))
        print(f"wrote {out.relative_to(ROOT)}; weights {dict(zip(['bias'] + SPECS[args.spec], [round(w, 2) for w in m['w']]))}")


if __name__ == "__main__":
    main()
