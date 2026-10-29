"""prlens triage-pr <GitHub PR URL>: triage a live pull request the same way as the evaluation set.

    prlens triage-pr https://github.com/owner/repo/pull/123 --plan-only   # fetch the diff, count calls and cost
    prlens triage-pr https://github.com/owner/repo/pull/123 --yes         # score it and save it for the dashboard

Fetches the PR and its diff from the GitHub API (public repos; set GITHUB_TOKEN for private ones or higher rate
limits), applies the no-model skips and must-review rules, scores each remaining region with the model, combines
the scores with the fitted weights in data/triage/combiner.json, and adds the PR to data/triage_live.json, which
the backend imports automatically. The skip threshold and promise come from the evaluation set (Python); for
other languages the promise is not calibrated and the PR says so.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np

from .bugdata import ROOT
from .export import build
from .fit import combiner_path, feats, predict
from .languages import language_of
from .hunks import defs_in, parse_diff, regions, review_rules, skip_category
from .llm import confirm, plan_line, spec
from .score import prompt_for, score_region

URL_RE = re.compile(r"^https://github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/pull/(\d+)(?:[/#?].*)?$")
OUT = ROOT / "data" / "triage_live.json"
COMBINER = ROOT / "data" / "triage" / "combiner.json"
EVAL = ROOT / "data" / "triage_eval.json"
MAX_FILES = 60
PY_EXT = (".py",)


def pr_id(owner: str, repo: str, number: int) -> str:
    return f"github:{owner}/{repo}#{number}"


def gh(url: str, accept: str = "application/vnd.github+json") -> str:
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "prlens"})
    token = os.getenv("GITHUB_TOKEN")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        hint = " (rate limited: set GITHUB_TOKEN)" if e.code == 403 else " (private repo? set GITHUB_TOKEN)" if e.code == 404 else ""
        raise SystemExit(f"GitHub returned {e.code} for {url}{hint}") from e


def fetch(owner: str, repo: str, number: int) -> dict:
    """The PR in the shape trace.py writes (hunks with regions), ready to score."""
    api = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}"
    meta = json.loads(gh(api))
    diff = gh(api, accept="application/vnd.github.v3.diff")
    files = [f for f in parse_diff(diff) if not f.binary]
    if len(files) > MAX_FILES:
        raise SystemExit(f"this PR changes {len(files)} files; live triage handles up to {MAX_FILES}")
    base = meta["base"]["sha"]
    pr_defs = defs_in([l for f in files for h in f.hunks for l in h.lines], "add")
    hunks = []
    for f in files:
        old_src = None
        if f.old_path and language_of(f.old_path) is not None:
            try:
                old_src = gh(f"https://raw.githubusercontent.com/{owner}/{repo}/{base}/{f.old_path}", accept="*/*")
            except SystemExit:
                old_src = None  # without the old file the formatting proof is skipped; the hunk is scored instead
        for i, h in enumerate(f.hunks):
            regs = [{"id": f"{h.file}#{i}.{j}", "added": r.added, "removed": r.removed,
                     "new_lines": sorted(r.new_lines()), "old_lines": sorted(l.old for l in r.lines if l.kind == "del"),
                     "rules": review_rules(r, pr_defs), "bug": False} for j, r in enumerate(regions(h))]
            hunks.append({"id": f"{h.file}#{i}", "file": h.file, "header": h.header, "added": h.added,
                          "removed": h.removed, "new_start": h.new_start, "new_len": h.new_len,
                          "lines": [[l.kind, l.old, l.new, l.text] for l in h.lines],
                          "skip": skip_category(h, old_src), "rules": review_rules(h, pr_defs),
                          "regions": regs, "bug": False, "bug_ids": []})
    user = meta.get("user") or {}
    return {
        "pr_id": pr_id(owner, repo, number), "repo": f"{owner}/{repo}", "sha": meta["head"]["sha"],
        "number": number, "branch": meta["head"]["ref"], "base": meta["base"]["ref"], "url": meta["html_url"],
        "subject": meta["title"], "message": (meta.get("body") or meta["title"]).strip(),
        "author": user.get("login", "unknown"), "author_is_bot": user.get("type") == "Bot" or str(user.get("login", "")).endswith("[bot]"),
        "date": meta["created_at"], "lines": sum(h["added"] + h["removed"] for h in hunks), "bugs": [], "hunks": hunks,
    }


def to_score(pr: dict) -> list[tuple[dict, dict]]:
    return [(h, g) for h in pr["hunks"] if not h["skip"] for g in h["regions"]]


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--model", default="spark_open")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--threshold", type=float, default=None,
                    help="skip threshold to use (the dashboard passes the repository's adaptive threshold)")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--plan-only", action="store_true")
    args = ap.parse_args(argv)
    m = URL_RE.match(args.url.strip())
    if not m:
        raise SystemExit("expected a pull request link like https://github.com/owner/repo/pull/123")
    if not COMBINER.exists():
        raise SystemExit("data/triage/combiner.json is missing: run `prlens fit --save` first")
    owner, repo, number = m.group(1), m.group(2), int(m.group(3))
    s = spec(args.model)
    pr = fetch(owner, repo, number)
    todo = to_score(pr)
    skipped = sum(1 for h in pr["hunks"] if h["skip"])
    avg_in = int(statistics.mean(len(prompt_for(pr, h, g)) for h, g in todo) / 4) if todo else 0
    os.environ.setdefault("PLAN_INPUT_TOKENS", str(avg_in))
    line, _ = plan_line(s, len(todo), 450)
    langs = sorted({h["file"].rsplit(".", 1)[-1] for h in pr["hunks"] if "." in h["file"]})
    confirm(f"{pr['repo']} #{number}: {pr['subject']}\n"
            f"{len(pr['hunks'])} hunks, {pr['lines']} changed lines; {skipped} hunks skipped without a model; "
            f"{len(todo)} regions to score with {s.name} ({s.model_id} on {s.provider}).\n{line}\n"
            f"File types: {', '.join(langs) or 'none'} (each language is calibrated on its own evaluation set).\n"
            + (f"Skip threshold: bug chance under {args.threshold:.2%} (this repository's adaptive threshold)."
               if args.threshold is not None else "Skip threshold: the evaluation set's."),
            args.yes, args.plan_only)

    with ThreadPoolExecutor(args.workers) as ex:
        results = list(ex.map(lambda hg: score_region(s, pr, *hg), todo))
    errors = [r for r in results if r["error"]]
    print(f"scored {len(results) - len(errors)}/{len(results)} regions", flush=True)
    if errors and len(errors) == len(results):
        raise SystemExit(f"every call failed, e.g. {errors[0]['error'][:300]}")

    # the PR's main language (by changed lines) picks the calibration; Python's is the fallback
    weight: dict[str, int] = {}
    for h in pr["hunks"]:
        lg = language_of(h["file"])
        if lg and not h["skip"]:
            weight[lg.name] = weight.get(lg.name, 0) + h["added"] + h["removed"]
    language = max(weight, key=weight.get) if weight else "python"
    calibrated = combiner_path(language).exists()
    comb = json.loads((combiner_path(language) if calibrated else COMBINER).read_text())
    by_id = {g["id"]: r for (h, g), r in zip(todo, results)}
    pr["units"] = []
    for h in pr["hunks"]:
        for g in h["regions"]:
            r = by_id.get(g["id"], {})
            u = dict(g, file=h["file"], skip=h["skip"], lines=[l for l in h["lines"] if l[2] in g["new_lines"]],
                     risk=r.get("risk"), reason=r.get("reason", ""))
            # a failed call counts as maximal uncertainty: it goes to review rather than being skipped
            u["p"] = 1.0 if (not h["skip"] and r.get("risk") is None) else float(predict(comb, np.array([feats(u)]))[0])
            pr["units"].append(u)
    ev_path = EVAL if language == "python" else EVAL.with_name(f"triage_eval_{language}.json")
    ev = json.loads(ev_path.read_text()) if calibrated and ev_path.exists() else None
    note = (f"{language} evaluation set ({ev['summary']['prs']} PRs; held out by repo, {ev['summary']['held_out_missed']} "
            f"of {ev['summary']['prs']} bugs were skipped)") if ev else "the Python evaluation set"
    if not calibrated:
        note += f"; not yet calibrated for {language}"
    guarantee = {"missBound": comb.get("alpha", 0.2), "confidence": 0.9, "calibratedOn": note}
    threshold = comb["threshold"] if args.threshold is None else args.threshold
    out = build(pr, threshold, guarantee)
    out.pop("groundTruth", None)
    out["language"] = language
    out.update(number=number, branch=pr["branch"], base=pr["base"], url=pr["url"], source="live", openedAt=pr["date"],
               taskSummary=pr["message"][:1500] or pr["subject"], panel=[s.name, "combiner", "rules"],
               author={"name": pr["author"], "kind": "ai_agent" if pr["author_is_bot"] else "human",
                       **({"agent": pr["author"]} if pr["author_is_bot"] else {})})

    current = json.loads(OUT.read_text()) if OUT.exists() else {"prs": []}
    prs = [p for p in current.get("prs", []) if p["id"] != out["id"]] + [out]
    read = sum(sum(i["added"] + i["removed"] for i in p["toReview"]) for p in prs)
    total = read + sum(sum(i["added"] + i["removed"] for i in p["skipped"]) for p in prs)
    OUT.write_text(json.dumps({
        "kind": "triage", "name": "live", "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "model": args.model, "threshold": threshold, "alpha": comb.get("alpha", 0.2),
        "summary": {"prs": len(prs), "repos": len({p["repo"] for p in prs}), "missed": 0,
                    "read_share": read / max(1, total), "held_out_missed": 0, "held_out_read_share": 0},
        "prs": prs,
    }))
    mine_read = sum(i["added"] + i["removed"] for i in out["toReview"])
    print(f"saved {out['id']}: {len(out['toReview'])} to review, {len(out['skipped'])} skipped, "
          f"{mine_read} of {pr['lines']} lines to read")
    print(f"PRLENS_PR_ID={out['id']}")
