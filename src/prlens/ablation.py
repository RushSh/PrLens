"""Does the model earn its place? Ablation, baselines, reliability and a repository bootstrap, per language.

    prlens ablation --language python            # prints the table; --save writes data/triage/ablation_<lang>.json

Every ranking is judged the same way, out of fold (a repository is never scored by a fit that saw it):
  - AUC over the regions the combiner ranks (scored, not forced into review by a rule);
  - the 20% miss target: the most aggressive threshold whose 90% Clopper-Pearson bound on the miss rate is <= alpha,
    chosen on all PRs and, as the honest check, without each repository (held out);
  - the same reading budget: how many bugs each ranking keeps when it reads no more lines than PR Lens does.
Rankings: random (mean of 200 draws), logic density alone, code features without the model (logistic, cross-fit),
Spark Open alone, PR Lens combined (the fixed spec), and the earlier spec with must-review regions in the fit
(comparison only).

Reliability: out-of-fold risk score against the observed bug rate, in ten equal-count bins, with Brier score and
expected calibration error. Bootstrap: repositories resampled with replacement (2,000 draws); the miss rate at the
chosen threshold, reported as its 90th percentile beside the Clopper-Pearson bound.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import random

import numpy as np

from .bugdata import ROOT
from .fit import cross_fit, feats, fit, held_out, load, pick, predict, scored, skip_outcome, ucb

CODE_FEATURES = [1, 2, 3]  # log logic, test file, log size (indices into fit.feats)


def ranked(u) -> bool:
    return scored(u) and not u["rules"]


def auc(prs) -> float:
    pos = [u["p"] for p in prs for u in p["units"] if ranked(u) and u["bug"]]
    neg = [u["p"] for p in prs for u in p["units"] if ranked(u) and not u["bug"]]
    if not pos or not neg:
        return float("nan")
    neg_sorted = np.sort(neg)
    wins = sum(np.searchsorted(neg_sorted, a, "left") + 0.5 * (np.searchsorted(neg_sorted, a, "right")
                                                                 - np.searchsorted(neg_sorted, a, "left")) for a in pos)
    return float(wins / (len(pos) * len(neg)))


def set_scores(prs, how: str, rng: random.Random | None = None) -> None:
    """Fill u['p'] for every scored region by one ranking (unscored regions: 1.0, always read)."""
    if how in ("combined", "with-must-review"):
        cross_fit(prs, "scored-only" if how == "combined" else "with-must-review")
        return
    if how == "code features":
        units = [(p, u) for p in prs for u in p["units"] if scored(u)]
        train = [(p, u) for p, u in units if not u["rules"]]
        X = np.array([[feats(u)[i] for i in CODE_FEATURES] for _, u in train])
        y = np.array([float(u["bug"]) for _, u in train])
        for repo in sorted({p["repo"] for p in prs}):
            tr = np.array([p["repo"] != repo for p, _ in train])
            m = fit(X[tr], y[tr])
            mine = [u for p, u in units if p["repo"] == repo]
            for u, pv in zip(mine, predict(m, np.array([[feats(u)[i] for i in CODE_FEATURES] for u in mine]))):
                u["p"] = float(pv)
    for p in prs:
        for u in p["units"]:
            if u["skip"]:
                u["p"] = 0.0
            elif u["risk"] is None:
                u["p"] = 1.0
            elif how == "random":
                u["p"] = rng.random()
            elif how == "logic density":
                u["p"] = feats(u)[1] + 1e-9 * rng.random()  # tiny jitter breaks ties without reordering
            elif how == "spark open":
                u["p"] = u["risk"] + 1e-9 * rng.random()


def at_target(prs, alpha: float) -> dict:
    t = pick(prs, alpha)
    k, r, tot, _ = skip_outcome(prs, t)
    hk, hr, ht = held_out(prs, alpha)
    return {"threshold": t, "missed": k, "read_share": r / tot, "held_out_missed": hk, "held_out_read_share": hr / ht}


def at_budget(prs, budget: float) -> dict:
    """Most bugs kept while reading no more than `budget` of the lines (the best threshold for this ranking)."""
    ts = sorted({u["p"] for p in prs for u in p["units"] if not u["skip"]})
    best = None
    lo, hi = 0, len(ts) - 1
    while lo <= hi:  # reading falls as the threshold rises: find the lowest threshold within budget
        mid = (lo + hi) // 2
        k, r, tot, _ = skip_outcome(prs, ts[mid])
        if r / tot <= budget:
            best = (k, r / tot)
            hi = mid - 1
        else:
            lo = mid + 1
    if best is None:
        k, r, tot, _ = skip_outcome(prs, 1.01)
        best = (k, r / tot)
    return {"missed": best[0], "kept": len(prs) - best[0], "read_share": best[1]}


def reliability(prs, bins: int = 10) -> dict:
    pts = sorted((u["p"], float(u["bug"])) for p in prs for u in p["units"] if ranked(u))
    n = len(pts)
    out, ece = [], 0.0
    for b in range(bins):
        chunk = pts[b * n // bins:(b + 1) * n // bins]
        if not chunk:
            continue
        mp = sum(x for x, _ in chunk) / len(chunk)
        ob = sum(y for _, y in chunk) / len(chunk)
        out.append({"mean_score": round(mp, 4), "bug_rate": round(ob, 4), "regions": len(chunk),
                    "bugs": int(sum(y for _, y in chunk))})
        ece += len(chunk) / n * abs(mp - ob)
    brier = sum((x - y) ** 2 for x, y in pts) / n
    base = sum(y for _, y in pts) / n
    return {"bins": out, "brier": round(brier, 5), "brier_base_rate": round(base * (1 - base), 5), "ece": round(ece, 4),
            "regions": n, "base_rate": round(base, 4)}


def bootstrap(prs, t: float, draws: int = 2000, seed: int = 7) -> dict:
    """Repositories resampled with replacement; the miss rate at the fixed threshold t."""
    by_repo: dict[str, list] = {}
    for p in prs:
        by_repo.setdefault(p["repo"], []).append(p)
    repos = sorted(by_repo)
    per = {r: skip_outcome(by_repo[r], t) for r in repos}
    rng = random.Random(seed)
    rates = []
    for _ in range(draws):
        pick_r = [rng.choice(repos) for _ in repos]
        k = sum(per[r][0] for r in pick_r)
        n = sum(len(by_repo[r]) for r in pick_r)
        rates.append(k / n)
    rates.sort()
    q = lambda f: rates[min(len(rates) - 1, int(f * len(rates)))]  # noqa: E731
    k, *_ = skip_outcome(prs, t)
    return {"draws": draws, "repos": len(repos), "observed": k / len(prs), "p50": q(0.5), "p90": q(0.9), "p95": q(0.95),
            "clopper_pearson_90": ucb(k, len(prs))}


ROWS = ["random", "logic density", "code features", "spark open", "combined", "with-must-review"]
LABELS = {"random": "Random skipping", "logic density": "Logic density alone",
          "code features": "Code features, no model", "spark open": "Spark Open alone",
          "combined": "PR Lens combined", "with-must-review": "PR Lens, must-review regions in the fit (comparison)"}


def analyze(prs_in, alpha: float = 0.2, random_draws: int = 200) -> dict:
    rng = random.Random(1)
    rows = {}
    for how in ROWS:
        if how == "random":
            acc = []
            for i in range(random_draws):
                prs = copy.deepcopy(prs_in) if i == 0 else prs
                set_scores(prs, "random", rng)
                acc.append(at_target(prs, alpha) | {"auc": auc(prs)})
            rows[how] = {k: float(np.mean([a[k] for a in acc])) for k in acc[0]}
            continue
        prs = copy.deepcopy(prs_in)
        set_scores(prs, how, rng)
        rows[how] = at_target(prs, alpha) | {"auc": auc(prs)}
        if how == "combined":
            combined_prs = prs
    budget = rows["combined"]["read_share"]
    for how in ROWS:
        if how == "random":
            ks = []
            for _ in range(random_draws):
                prs = copy.deepcopy(prs_in) if not ks else prs
                set_scores(prs, "random", rng)
                ks.append(at_budget(prs, budget)["kept"])
            rows[how]["kept_at_budget"] = float(np.mean(ks))
            continue
        prs = copy.deepcopy(prs_in)
        set_scores(prs, how, rng)
        rows[how]["kept_at_budget"] = at_budget(prs, budget)["kept"]
    return {"alpha": alpha, "prs": len(prs_in), "budget": budget,
            "rows": [{"key": k, "label": LABELS[k], **{kk: (round(v, 4) if isinstance(v, float) else v)
                                                      for kk, v in rows[k].items()}} for k in ROWS],
            "reliability": reliability(combined_prs),
            "bootstrap": bootstrap(combined_prs, rows["combined"]["threshold"])}


def path_for(language: str):
    return ROOT / "data" / "triage" / f"ablation_{language}.json"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--language", default="python")
    ap.add_argument("--alpha", type=float, default=0.2)
    ap.add_argument("--random-draws", type=int, default=200)
    ap.add_argument("--save", action="store_true")
    args = ap.parse_args(argv)
    prs = load(args.model, args.language)
    res = analyze(prs, args.alpha, args.random_draws)
    n = res["prs"]
    print(f"{args.language}: {n} PRs, target {args.alpha:.0%} misses (90% bound); PR Lens reads {res['budget']:.0%}")
    print(f"  {'ranking':52s} {'AUC':>5s} {'missed':>7s} {'read':>5s} {'held-out missed/read':>21s} {'kept at PR Lens budget':>23s}")
    for r in res["rows"]:
        print(f"  {r['label']:52s} {r['auc']:5.2f} {r['missed']:7.1f} {r['read_share']:5.0%} "
              f"{r['held_out_missed']:12.1f} / {r['held_out_read_share']:4.0%} {r['kept_at_budget']:15.1f} of {n}")
    rel = res["reliability"]
    print(f"  reliability: Brier {rel['brier']} (base-rate guess {rel['brier_base_rate']}), ECE {rel['ece']}; bins (score -> bug rate): "
          + ", ".join(f"{b['mean_score']:.2f}->{b['bug_rate']:.2f}" for b in rel["bins"]))
    b = res["bootstrap"]
    print(f"  repository bootstrap ({b['repos']} repos, {b['draws']} draws) at the chosen threshold: observed {b['observed']:.1%}, "
          f"p90 {b['p90']:.1%}, p95 {b['p95']:.1%} (Clopper-Pearson 90%: {b['clopper_pearson_90']:.1%})")
    if args.save:
        path_for(args.language).write_text(json.dumps(res, indent=1))
        print(f"wrote {path_for(args.language).relative_to(ROOT)}")
