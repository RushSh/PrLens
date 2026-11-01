"""Write the traced PRs as PR Reviewer triage data for the dashboard: data/triage_eval.json.

    prlens export            # after prlens trace and prlens score

Each PR is laid out in the dashboard's PrTriage shape (web/shared/src/triage.ts). Regions get the combiner's
out-of-fold bug chance (fit without the PR's repo), so what the tab shows is what triage would have done on a
repo it had never seen. Regions at or above the skip threshold, or hit by a must-review rule, go to Action
required; the rest are skipped, with no-model skips (docs, formatting, config...) as their own categories.
The real bug's location travels along as groundTruth, for the dashboard's "reveal" toggle.
The backend imports the file automatically.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from .bugdata import ROOT
from .adaptive import orders
from .fit import cross_fit, held_out, load, pick, skip_outcome, ucb
from .trace import is_test, logic_density, read_until

OUT = ROOT / "data" / "triage_eval.json"
RULE_CODES = {"security_sensitive", "public_api", "data_migration", "error_handling", "prompt_injection"}
CONTEXT = 3
MAX_DIFF = 400


def diff_lines(lines, flag_new=(), flag_old=(), window=True):
    idx = [i for i, l in enumerate(lines)
           if (l[0] == "add" and l[2] in flag_new) or (l[0] == "del" and l[1] in flag_old)]
    lo, hi = 0, len(lines)
    if window and idx:
        lo, hi = max(0, idx[0] - CONTEXT), min(len(lines), idx[-1] + CONTEXT + 1)
    out = []
    for i, (kind, old, new, text) in enumerate(lines[lo:hi][:MAX_DIFF], start=lo):
        d = {"kind": kind, "oldNo": old, "newNo": new, "text": text}
        if i in idx:
            d["flagged"] = True
        out.append(d)
    return out


def priority(p: float, rules) -> str:
    codes = {r[0] for r in rules}
    if p >= 0.3 or codes & {"security_sensitive", "data_migration", "prompt_injection"}:
        return "P0"
    if p >= 0.12 or codes & {"public_api", "error_handling"}:
        return "P1"
    return "P2"


def edit_shape(item: dict) -> tuple | None:
    """What a region adds or removes around the code it keeps: wrapping nine different calls in the same try/catch has
    one shape. None when that is under two lines (a one-line change is its own thing)."""
    added = [l["text"].strip() for l in item["diff"] if l.get("flagged") and l["kind"] == "add"]
    deleted = [l["text"].strip() for l in item["diff"] if l.get("flagged") and l["kind"] == "del"]
    a, d = set(added), set(deleted)
    shape = (tuple(x for x in added if x not in d), tuple(x for x in deleted if x not in a))
    return shape if len(shape[0]) + len(shape[1]) >= 2 else None


def group_same_edits(items: list[dict]) -> None:
    """Mark review items that make the same edit as `sameEdit = {group, size}`; the group is named by its riskiest
    item, which the dashboard shows once ("same edit in 9 places") while the rest fold into one-line notes."""
    groups: dict[tuple, list[dict]] = {}
    for it in items:
        shape = edit_shape(it)
        if shape:
            groups.setdefault(shape, []).append(it)
    for members in groups.values():
        if len(members) < 2:
            continue
        lead = max(members, key=lambda m: (m["riskScore"], -members.index(m)))
        for m in members:
            m["sameEdit"] = {"group": lead["id"], "size": len(members)}


def build(pr, t: float, guarantee: dict) -> dict:
    to_review, skipped, bug_ids, hunks = [], [], [], []
    for h in pr["hunks"]:
        if not h["skip"]:
            # the whole hunk once, so the dashboard can show files the way GitHub does; items point into it
            hunks.append({"id": h["id"], "file": h["file"], "header": h["header"],
                          "diff": diff_lines(h["lines"], window=False)})
        if h["skip"]:
            cat, why = h["skip"]
            skipped.append({"id": h["id"], "file": h["file"], "header": h["header"], "added": h["added"],
                            "removed": h["removed"], "diff": diff_lines(h["lines"], window=False),
                            "tier": "skip", "category": cat, "reason": why, "riskScore": 0})
            if h["bug"]:
                bug_ids.append(h["id"])
            continue
        units = {u["id"]: u for u in pr["units"]}
        for g in h["regions"]:
            u = units[g["id"]]
            p, risk = u["p"], u["risk"] or 0.0
            base = {"id": g["id"], "file": h["file"], "header": h["header"], "added": g["added"],
                    "removed": g["removed"],
                    "diff": diff_lines(h["lines"], set(g["new_lines"]), set(g.get("old_lines", [])))}
            if g["bug"]:
                bug_ids.append(g["id"])
            reason = (u.get("reason") or "").strip()
            if u["risk"] is None:
                reason = "No model score for this region (the call failed), so it is always read."
            if g["rules"] or p >= t:
                reasons = []
                if p >= t:
                    reasons.append({"code": "bug_risk", "detail": reason or
                                    f"Logic-heavy change in {'a test' if is_test(u) else 'source'} file; "
                                    f"Spark Open rated it {risk:.0%}."})
                for code, detail in g["rules"]:
                    if code in RULE_CODES:
                        reasons.append({"code": code, "detail": detail})
                logic = logic_density(u)
                to_review.append(dict(base, tier="review", riskScore=round(p, 4), priority=priority(p, g["rules"]),
                                      reasons=reasons, forcedByRule=bool(g["rules"]) and p < t, signals=[
                                          {"name": "Spark Open risk", "value": "no score" if u["risk"] is None else f"{risk:.0%}",
                                           "weight": round(risk, 3)},
                                          {"name": "Logic operators changed", "value": str(int(logic)),
                                           "weight": round(min(1.0, logic / 12), 3)},
                                          {"name": "File", "value": "test" if is_test(u) else "source",
                                           "weight": 0.1 if is_test(u) else 0.6},
                                          {"name": "Combined risk score", "value": f"{p:.1%}",
                                           "weight": round(min(1.0, p / 0.5), 3)},
                                      ]))
            else:
                why = f"Combined risk score {p:.1%} is under the skip threshold ({t:.1%})."
                if reason:
                    why += f" Spark Open: {reason}"
                skipped.append(dict(base, tier="skip", category="low_score", reason=why, riskScore=round(p, 4)))
    group_same_edits(to_review)
    caught = any(i["id"] in bug_ids for i in to_review)
    msg = (pr.get("message") or pr["subject"]).strip()
    return {
        "id": pr["pr_id"], "number": None, "title": pr["subject"], "repo": pr["repo"], "branch": pr["sha"][:10],
        "author": {"name": pr["author"] or "unknown", "kind": "human"}, "openedAt": pr["date"],
        "taskSummary": msg[:600], "panel": ["Spark Open (Baseten)", "combiner", "rules"],
        "toReview": to_review, "skipped": skipped, "hunks": hunks, "guarantee": guarantee, "source": "eval",
        "skipThreshold": round(t, 5), "language": pr.get("language", "python"),
        "groundTruth": {"bugItemIds": bug_ids, "caughtByTriage": caught, "fixes": [
            {"sha": b["fix_sha"][:10], "subject": b["fix_subject"], "evidence": b["evidence"]} for b in pr["bugs"]]},
    }


def with_ablation(ev: dict, language: str) -> dict:
    """Attach `prlens ablation --save` results for this language when they exist."""
    from .ablation import path_for
    p = path_for(language)
    if p.exists():
        ev["ablation"] = json.loads(p.read_text())
    return ev


def evaluation(prs, t: float, alpha: float) -> dict:
    """What the Evaluation tab shows: the reading-vs-missing curve, per-repo results, ranking quality, PR sizes."""
    import numpy as np

    n = len(prs)
    ps = sorted({u["p"] for p in prs for u in p["units"] if not u["skip"]})
    grid = sorted({0.0, *np.quantile(ps, np.linspace(0, 1, 60)).tolist(), t})
    sweep = []
    for th in grid:
        k, r, tot, _ = skip_outcome(prs, th)
        sweep.append({"threshold": round(th, 5), "missed": k, "read_share": round(r / tot, 4),
                      "bound": round(ucb(k, n), 4)})
    by_repo = []
    for repo in sorted({p["repo"] for p in prs}):
        mine = [p for p in prs if p["repo"] == repo]
        k, r, tot, _ = skip_outcome(mine, t)
        by_repo.append({"repo": repo, "prs": len(mine), "missed": k, "read_share": round(r / tot, 4),
                        "lines": tot})
    gate = {}
    for name, frac in (("quarter", 1 / 4), ("third", 1 / 3), ("half", 1 / 2)):
        order = lambda p: sorted([u for u in p["units"] if not u["skip"]], key=lambda u: -u["p"])  # noqa: E731
        gate[name] = round(sum(read_until(p["units"], order(p), frac * p["lines"]) for p in prs) / n, 4)
    # the regions the combiner ranks (fit spec): scored, and not forced into review by a rule
    sc = lambda u: not u["skip"] and u["risk"] is not None and not u["rules"]  # noqa: E731
    pos = [u["p"] for p in prs for u in p["units"] if sc(u) and u["bug"]]
    neg = [u["p"] for p in prs for u in p["units"] if sc(u) and not u["bug"]]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / max(1, len(pos) * len(neg))
    rpos = [u["risk"] for p in prs for u in p["units"] if sc(u) and u["bug"]]
    rneg = [u["risk"] for p in prs for u in p["units"] if sc(u) and not u["bug"]]
    auc_model = sum((a > b) + 0.5 * (a == b) for a in rpos for b in rneg) / max(1, len(rpos) * len(rneg))
    sizes = sorted(p["lines"] for p in prs)
    return {
        "sweep": sweep, "by_repo": by_repo, "gate": gate,
        "auc": {"combined": round(auc, 3), "model": round(auc_model, 3)},
        "pr_lines": {"min": sizes[0], "median": sizes[n // 2], "p75": sizes[int(0.75 * (n - 1))], "max": sizes[-1]},
        "languages": {lang: sum(p.get("language", "python") == lang for p in prs) for lang in sorted({p.get("language", "python") for p in prs})},
        "evidence": {"deleted": sum(b["evidence"] == "deleted" for p in prs for b in p["bugs"]),
                     "adjacent": sum(b["evidence"] == "adjacent" for p in prs for b in p["bugs"])},
        "alpha": alpha, "confidence": 0.9,
        "drift": orders(prs),
        "dial": dial(prs),
    }


def dial(prs, alphas=None) -> list[dict]:
    """The miss target as a dial: for each target, the threshold PR Lens would pick and what it costs and risks,
    from the same out-of-fold scores (no refit). Held out: the threshold chosen without each PR's repository.
    threshold 0 means no score threshold meets the target, so only the no-model skips remain."""
    import numpy as np

    from .ablation import bootstrap
    n = len(prs)
    out = []
    for a in alphas if alphas is not None else np.round(np.arange(0.05, 0.401, 0.025), 3).tolist():
        t = pick(prs, a)
        k, r, tot, _ = skip_outcome(prs, t)
        hk, hr, ht = held_out(prs, a)
        out.append({"alpha": a, "threshold": round(t, 5), "missed": k, "read_share": round(r / tot, 4),
                    "bound": round(ucb(k, n), 4), "held_out_missed": hk, "held_out_read_share": round(hr / ht, 4),
                    "held_out_bound": round(ucb(hk, n), 4),
                    "bootstrap_p90": round(bootstrap(prs, t)["p90"], 4)})
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--alpha", type=float, default=0.2)
    ap.add_argument("--language", default="python")
    args = ap.parse_args(argv)
    prs = load(args.model, args.language)
    if not prs:
        raise SystemExit(f"no scored {args.language} PRs yet")
    target = OUT if args.language == "python" else OUT.with_name(f"triage_eval_{args.language}.json")
    set_name = "eval" if args.language == "python" else f"eval-{args.language}"
    cross_fit(prs)
    t = pick(prs, args.alpha)
    k, r, tot, _ = skip_outcome(prs, t)
    hk, hr, ht = held_out(prs, args.alpha)
    reasons = {}
    for l in open(ROOT / "data" / "triage" / "scores" / f"{args.model}.jsonl"):
        x = json.loads(l)
        if x["risk"] is not None:
            reasons[x["region"]] = x.get("reason", "")
    for p in prs:
        for u in p["units"]:
            u["reason"] = reasons.get(f"{p['pr_id']}|{u['id']}", "")
    repos = len({p["repo"] for p in prs})
    guarantee = {"missBound": args.alpha, "confidence": 0.9,
                 "calibratedOn": f"{len(prs)} real bug-introducing commits in {repos} repos; held out by repo, "
                                 f"{hk} of {len(prs)} bugs landed in the skipped part"}
    out = {
        "kind": "triage", "name": set_name, "language": args.language, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": args.model, "threshold": t, "alpha": args.alpha,
        "summary": {"prs": len(prs), "repos": repos, "missed": k, "read_share": r / tot,
                    "held_out_missed": hk, "held_out_read_share": hr / ht},
        "evaluation": with_ablation(evaluation(prs, t, args.alpha), args.language),
        "prs": [build(p, t, guarantee) for p in prs],
    }
    target.write_text(json.dumps(out))
    caught = sum(x["groundTruth"]["caughtByTriage"] for x in out["prs"])
    print(f"wrote {target.relative_to(ROOT)}: {len(prs)} {args.language} PRs, threshold {t:.3f}, bug kept for review in "
          f"{caught}/{len(prs)}, {r / tot:.0%} of lines to read ({target.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
