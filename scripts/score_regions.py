"""Score each region of each traced PR for bug risk with one model, then measure it against the gate.

    python scripts/score_regions.py run --model spark_open --bench 20 --plan-only   # what a 20-call test would do
    python scripts/score_regions.py run --model spark_open --bench 20               # the test: speed, tokens, parse rate
    python scripts/score_regions.py run --model spark_open                          # every region (resumes)
    python scripts/score_regions.py eval --model spark_open                         # gate numbers vs the free rankings

The model sees what a reviewer would: the PR's commit message, the file list, and the hunk with the region marked.
Nothing from the later fix is shown. Results go to data/triage/scores/<model>.jsonl, one line per region.
"""
from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from bugcensus.llm import chat, confirm, plan_line, spec  # noqa: E402
from trace_prs import OUT as PRS, is_test, logic_density, read_until  # noqa: E402

SCORES = ROOT / "data" / "triage" / "scores"

PROMPT = """You are triaging a pull request so a human reviewer reads only what needs a human.

PR message:
{message}

Files changed: {files}

Below is one hunk from {file}. Lines marked ">>" are the region you are scoring; the rest is context.

{hunk}

How likely is it that the marked lines introduce a functional bug: code that gives a wrong result, crashes, or
breaks existing callers for inputs the code is meant to handle? Ignore style, naming, docs and missing tests.

Reply with JSON only:
{{"risk": <probability from 0 to 1>, "reason": "<one sentence a reviewer can check, or empty if low risk>"}}"""


def units(prs: list[dict]) -> list[tuple[dict, dict, dict]]:
    """(pr, hunk, region) for every region a model should score (no-model skips excluded)."""
    out = []
    for p in prs:
        for h in p["hunks"]:
            if h["skip"]:
                continue
            for g in h["regions"]:
                out.append((p, h, g))
    return out


def render(p: dict, h: dict, g: dict) -> str:
    new, old = set(g["new_lines"]), set(g.get("old_lines", []))
    body = []
    for kind, o, n, text in h["lines"]:
        sign = {"add": "+", "del": "-", "ctx": " "}[kind]
        on = (kind == "add" and n in new) or (kind == "del" and o in old)
        body.append(f"{'>>' if on else '  '} {sign}{text}")
    return "\n".join(body[:220])


def prompt_for(p: dict, h: dict, g: dict) -> str:
    files = ", ".join(sorted({x["file"] for x in p["hunks"]}))
    msg = p.get("message") or p["subject"]
    return PROMPT.format(message=msg[:1500], files=files[:800], file=h["file"], hunk=f"{h['header']}\n" + render(p, h, g))


def run(args) -> None:
    s = spec(args.model)
    prs = [json.loads(l) for l in open(PRS)]
    todo = units(prs)
    out = SCORES / f"{args.model}.jsonl"
    done = set()
    if out.exists():
        done = {json.loads(l)["region"] for l in open(out) if not json.loads(l).get("error")}
    todo = [u for u in todo if f"{u[0]['pr_id']}|{u[2]['id']}" not in done]
    # regions with no added lines (pure deletions) are scored too; the model sees the hunk
    if args.bench:
        rng = random.Random(1)
        bugs = [u for u in todo if u[2]["bug"]]
        rest = [u for u in todo if not u[2]["bug"]]
        k = min(len(bugs), args.bench // 2)
        todo = rng.sample(bugs, k) + rng.sample(rest, min(len(rest), args.bench - k))
    avg_in = int(statistics.mean(len(prompt_for(*u)) for u in todo) / 4) if todo else 0
    import os
    os.environ.setdefault("PLAN_INPUT_TOKENS", str(avg_in))
    line, _ = plan_line(s, len(todo), args.out_tokens)
    confirm(f"Score {len(todo)} regions with {s.name} ({s.model_id} on {s.provider}); "
            f"~{avg_in} input tokens each, ~{avg_in * len(todo):,} in total.\n{line}\n"
            f"Writes {out.relative_to(ROOT)}", args.yes, args.plan_only)
    out.parent.mkdir(parents=True, exist_ok=True)
    stats = []

    def one(u):
        p, h, g = u
        r = chat(s, prompt_for(p, h, g), purpose="triage-region")
        js = r.json() if not r.error else None
        risk = js.get("risk") if isinstance(js, dict) else None
        try:
            risk = None if risk is None else max(0.0, min(1.0, float(risk)))
        except (TypeError, ValueError):
            risk = None
        err = r.error or (None if risk is not None else "no risk in reply")
        return {"region": f"{p['pr_id']}|{g['id']}", "pr_id": p["pr_id"], "model": s.model_id, "risk": risk,
                "reason": (js or {}).get("reason", "") if isinstance(js, dict) else "", "error": err,
                "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "seconds": round(r.seconds, 2)}

    t0 = time.time()
    with ThreadPoolExecutor(args.workers) as ex, open(out, "a") as fh:
        futs = [ex.submit(one, u) for u in todo]
        for i, f in enumerate(as_completed(futs), 1):
            rec = f.result()
            fh.write(json.dumps(rec) + "\n")
            fh.flush()
            stats.append(rec)
            if i % 10 == 0 or i == len(todo):
                errs = sum(1 for x in stats if x["error"])
                print(f"  {i}/{len(todo)} scored, {errs} errors, {time.time() - t0:.0f}s", flush=True)
    ok = [x for x in stats if not x["error"]]
    if stats:
        print(f"\n{len(ok)}/{len(stats)} parsed; wall {time.time() - t0:.0f}s with {args.workers} workers")
    if ok:
        ins = [x["input_tokens"] or 0 for x in ok]
        outs = [x["output_tokens"] or 0 for x in ok]
        secs = [x["seconds"] for x in ok]
        print(f"per call: input {statistics.mean(ins):.0f} tok, output {statistics.mean(outs):.0f} tok "
              f"(max {max(outs)}), {statistics.mean(secs):.1f}s (max {max(secs):.1f}s)")
        full = len(units(prs))
        print(f"full set: {full} regions -> ~{full * statistics.mean(ins) / 1e6:.2f}M input and "
              f"~{full * statistics.mean(outs) / 1e6:.2f}M output tokens; "
              f"~{full * statistics.mean(secs) / args.workers / 60:.0f} min with {args.workers} workers")
    for x in [x for x in stats if x["error"]][:5]:
        print("  error:", x["region"], x["error"][:200])


def evaluate(args) -> None:
    prs = [json.loads(l) for l in open(PRS)]
    sc = {}
    for m in args.model:
        f = SCORES / f"{m}.jsonl"
        for l in open(f):
            x = json.loads(l)
            if x["risk"] is not None:
                sc.setdefault(x["region"], {})[m] = x["risk"]
    # region units, as in trace_prs baseline --unit region
    for p in prs:
        p["units"] = []
        for h in p["hunks"]:
            for g in h["regions"]:
                lines = [l for l in h["lines"] if l[2] in g["new_lines"]]
                p["units"].append(dict(g, file=h["file"], skip=h["skip"], lines=lines,
                                       score=sc.get(f"{p['pr_id']}|{g['id']}", {})))
    covered = [p for p in prs if all(u["skip"] or u["score"] for u in p["units"])]
    print(f"{len(covered)}/{len(prs)} PRs fully scored by {', '.join(args.model)}")
    if not covered:
        return
    n = len(covered)

    def mean_score(u):
        return statistics.mean(u["score"].values()) if u["score"] else 0.0

    rankers = {
        "random order": lambda us: random.Random(0).sample(us, len(us)),
        "logic, source before tests (free)": lambda us: sorted(us, key=lambda u: (is_test(u), -logic_density(u))),
        "model risk": lambda us: sorted(us, key=lambda u: -mean_score(u)),
        "model risk, source before tests": lambda us: sorted(us, key=lambda u: (is_test(u), -mean_score(u))),
        "model risk x logic": lambda us: sorted(us, key=lambda u: (is_test(u), -(mean_score(u) * (1 + logic_density(u))))),
    }
    print(f"{'ranking':36s} {'1/3 of lines':>13s} {'1/2 of lines':>13s}")
    for name, rank in rankers.items():
        row = []
        for frac in (1 / 3, 1 / 2):
            hits = sum(read_until(p["units"], rank([u for u in p["units"] if not u["skip"]]), frac * p["lines"])
                       for p in covered)
            row.append(hits / n)
        print(f"{name:36s} {row[0]:13.0%} {row[1]:13.0%}")
    # how well the score separates bug regions from the rest
    pos = [mean_score(u) for p in covered for u in p["units"] if u["bug"] and u["score"]]
    neg = [mean_score(u) for p in covered for u in p["units"] if not u["bug"] and u["score"]]
    if pos and neg:
        auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg))
        print(f"\nregion AUC (bug vs other): {auc:.2f}  (bug regions {len(pos)}, others {len(neg)})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--model", default="spark_open")
    r.add_argument("--bench", type=int, default=0, help="score only this many regions (half of them bug regions)")
    r.add_argument("--workers", type=int, default=8)
    r.add_argument("--out-tokens", type=int, default=1000, help="output tokens a call, for the cost estimate")
    r.add_argument("--yes", action="store_true")
    r.add_argument("--plan-only", action="store_true")
    r.set_defaults(fn=run)
    e = sub.add_parser("eval")
    e.add_argument("--model", nargs="+", default=["spark_open"])
    e.set_defaults(fn=evaluate)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
