"""Write the traced PRs as PR Reviewer triage data for the dashboard: data/triage_eval.json.

    python scripts/export_triage.py            # after trace_prs.py trace and score_regions.py run

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

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))
from fit_triage import cross_fit, held_out, load, pick, skip_outcome  # noqa: E402
from trace_prs import is_test, logic_density  # noqa: E402

OUT = ROOT / "data" / "triage_eval.json"
RULE_CODES = {"security_sensitive", "public_api", "data_migration"}
CONTEXT = 3
MAX_DIFF = 120


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
    if p >= 0.3 or codes & {"security_sensitive", "data_migration"}:
        return "P0"
    if p >= 0.12 or "public_api" in codes:
        return "P1"
    return "P2"


def build(pr, t: float, guarantee: dict) -> dict:
    to_review, skipped, bug_ids = [], [], []
    for h in pr["hunks"]:
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
                                          {"name": "Spark Open risk", "value": f"{risk:.0%}", "weight": round(risk, 3)},
                                          {"name": "Logic operators changed", "value": str(int(logic)),
                                           "weight": round(min(1.0, logic / 12), 3)},
                                          {"name": "File", "value": "test" if is_test(u) else "source",
                                           "weight": 0.1 if is_test(u) else 0.6},
                                          {"name": "Combined bug chance", "value": f"{p:.1%}",
                                           "weight": round(min(1.0, p / 0.5), 3)},
                                      ]))
            else:
                why = f"Combined bug chance {p:.1%} is under the skip threshold ({t:.1%})."
                if reason:
                    why += f" Spark Open: {reason}"
                skipped.append(dict(base, tier="skip", category="low_score", reason=why, riskScore=round(p, 4)))
    caught = any(i["id"] in bug_ids for i in to_review)
    msg = (pr.get("message") or pr["subject"]).strip()
    return {
        "id": pr["pr_id"], "number": None, "title": pr["subject"], "repo": pr["repo"], "branch": pr["sha"][:10],
        "author": {"name": pr["author"] or "unknown", "kind": "human"}, "openedAt": pr["date"],
        "taskSummary": msg[:600], "panel": ["Spark Open (Baseten)", "combiner", "rules"],
        "toReview": to_review, "skipped": skipped, "guarantee": guarantee, "source": "eval",
        "groundTruth": {"bugItemIds": bug_ids, "caughtByTriage": caught, "fixes": [
            {"sha": b["fix_sha"][:10], "subject": b["fix_subject"], "evidence": b["evidence"]} for b in pr["bugs"]]},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--alpha", type=float, default=0.2)
    args = ap.parse_args()
    prs = load(args.model)
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
        "kind": "triage", "name": "eval", "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": args.model, "threshold": t, "alpha": args.alpha,
        "summary": {"prs": len(prs), "repos": repos, "missed": k, "read_share": r / tot,
                    "held_out_missed": hk, "held_out_read_share": hr / ht},
        "prs": [build(p, t, guarantee) for p in prs],
    }
    OUT.write_text(json.dumps(out))
    caught = sum(x["groundTruth"]["caughtByTriage"] for x in out["prs"])
    print(f"wrote {OUT.relative_to(ROOT)}: {len(prs)} PRs, threshold {t:.3f}, bug kept for review in "
          f"{caught}/{len(prs)}, {r / tot:.0%} of lines to read ({OUT.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
