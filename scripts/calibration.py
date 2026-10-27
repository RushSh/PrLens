"""Calibration: when BugCensus says N bugs are still hidden, are there about N?

Design (fixed before any model sees the data):
  - A calibration UNIT is a small change made of BLOCKS functions from one repository. Each function comes
    from a real, test-confirmed bug fix (the realism-check data). Exactly k of them (k = 0..BLOCKS, balanced)
    are in their BUGGY (pre-fix) version; the rest are FIXED. So the true number of real bugs is known.
  - Each function carries a menu of the realism check's test-validated decoys (the fix's own test fails on
    them), restricted to edits in code that is identical in the buggy and fixed versions, so the same menu
    exists whichever version is in the unit.
  - Each unit is censused exactly the way the product censuses a PR:
      1. every panel model reviews the ORIGINAL (fresh call, normal review prompt);
      2. COPIES seeded copies are built from the decoy menus, skipping lines the original review flagged
         (tight findings, +-1), the same rule as the pipeline;
      3. every panel model reviews every copy.
  - Found bugs are counted the way the product will count them once the verifier exists: a real bug is
    found when a tight finding (<= MAX_SPAN lines) in the ORIGINAL covers its lines (+-1).
  - Truth: actual hidden = k - found. Prediction: the census estimate E[R], 90% interval and P(clean).
  - The Gamma prior on the bug rate is cross-fitted by repository: each unit's prior is fitted (from observed
    counts only, never from truth) on the units of the other repositories.
  - Metrics: binned predicted vs actual with cluster-bootstrap CIs (clusters = repositories), slope,
    actual/predicted totals, 90%-interval coverage, P(clean) reliability, the Clear rule's false-clear
    rate, and AUC for "anything still hidden" (estimate vs the number of findings).

Caveats (also written into the results): fixed functions may contain other, unknown bugs (actual hidden is a
lower bound); decoys were test-validated on the fixed version; each bug appears in up to ROUNDS units.

Stages (only `bench` and `run` call models; both show the cost and ask first):
  python scripts/calibration.py prepare                            build data/calibration_units.jsonl (git only)
  python scripts/calibration.py plan  --panel spark,glimmer_fw     calls, rough cost and time (no calls)
  python scripts/calibration.py dry-run                            everything with fake reviewers (no calls)
  python scripts/calibration.py bench --panel glimmer_fw           a few calls to measure speed, then project
  python scripts/calibration.py run   --panel spark,glimmer_fw --tag fw1      review every unit (resumable)
  python scripts/calibration.py analyze --tag fw1 --name "Spark + Glimmer (Fireworks)"
Results go to data/calibration/<tag>/ (reviews, copies) and data/calibration_<name>.json (the dashboard).
"""
from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import random
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from bugcensus.estimate import census, fit_prior, fit_q_prior  # noqa: E402
from realism import MAX_SPAN, caught, find_func, snippet  # noqa: E402

BLOCKS = 3              # functions per unit
ROUNDS = 4              # each bug appears in at most this many units (different company each time)
KS = (0, 1, 2, 3)       # buggy functions per unit, balanced
COPIES = 2
MAX_BLOCK_LINES = 250   # longer functions are left out (keeps units a realistic PR size)
DEV_SHARE = 0.3         # a split label kept for an optional held-out check; analysis uses all units by default

UNITS = ROOT / "data" / "calibration_units.jsonl"
EXP_DIR = ROOT / "data" / "calibration"

# Rough output tokens per review call, measured on Oct 26-27 (function-sized code).
OUT_TOKENS = {"spark": 3650, "wonder": 4230, "mlx-local": 5200, "fireworks": 5200, "baseten": 3650}
META_PER_CALL = {"spark": 0.017, "wonder": 0.09}   # Oct 26 realism-check averages
LOCAL_TPS = 17.7                                      # M3 Max, 4-bit MLX


# =========================================================================================== prepare

def _git_show(repo: Path, spec: str) -> str | None:
    r = subprocess.run(["git", "show", spec], cwd=repo, capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def _find_repo(name: str, raw_dirs: list[Path]) -> Path | None:
    for d in raw_dirs:
        if (d / name / ".git").exists():
            return d / name
    return None


def _transplant(f_text: str, p_text: str, m_text: str, decoy_line: int):
    """A decoy validated on the FIXED block (m_text = fixed block with the decoy) as the same edit on both
    the fixed and the BUGGY block. Only single local edits in code identical in both versions qualify.
    Returns ((fixed_block, line), (buggy_block, line)) or None."""
    f, m, p = f_text.splitlines(), m_text.splitlines(), p_text.splitlines()
    ops = [o for o in difflib.SequenceMatcher(None, f, m, autojunk=False).get_opcodes() if o[0] != "equal"]
    if len(ops) != 1:
        return None
    _, i1, i2, j1, j2 = ops[0]
    fmap = {}
    for tag, a1, a2, b1, b2 in difflib.SequenceMatcher(None, p, f, autojunk=False).get_opcodes():
        if tag == "equal":
            for k in range(a2 - a1):
                fmap[b1 + k] = a1 + k
    idx = list(range(i1, i2)) or [i1]
    if any(i not in fmap for i in idx) or any(fmap[idx[n + 1]] != fmap[idx[n]] + 1 for n in range(len(idx) - 1)):
        return None
    pi1 = fmap[i1]
    pi2 = pi1 + (i2 - i1)
    buggy = p[:pi1] + m[j1:j2] + p[pi2:]
    b_line = pi1 + (decoy_line - 1 - j1) + 1
    if not (1 <= decoy_line <= len(m)) or not (1 <= b_line <= len(buggy)):
        return None
    return (m_text, decoy_line), ("\n".join(buggy) + "\n", b_line)


def prepare(args):
    realism = [json.loads(l) for l in Path(args.realism_units).read_text().splitlines() if l.strip()]
    by_bug = defaultdict(list)
    for u in realism:
        by_bug[u["bug_id"]].append(u)
    records = {}
    for path in args.bugs.split(","):
        for line in Path(path).read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                records[f"{r['name']}@{r['sha'][:10]}"] = r
    raw_dirs = [Path(p).expanduser() for p in args.raw.split(",")]

    pool, skipped = defaultdict(list), Counter()
    for bug_id, us in sorted(by_bug.items()):
        real = [u for u in us if u["kind"] == "real"]
        if len(real) != 1:
            skipped["multi-file fix"] += 1
            continue
        real = real[0]
        rec = records.get(bug_id)
        repo = _find_repo(bug_id.split("@")[0], raw_dirs) if rec else None
        if not rec or not repo:
            skipped["no repo clone"] += 1
            continue
        src = real["file"]
        fixed_src = _git_show(repo, f"{rec['sha']}:{src}")
        funcs = [f for f in rec["functions"] if f["file"] == src]
        ranges = [find_func(fixed_src, f["name"], f["start"]) for f in funcs] if fixed_src else [None]
        if None in ranges:
            skipped["fixed function not found"] += 1
            continue
        f_text, _ = snippet(fixed_src, ranges)
        p_text = real["snippet"]
        if max(len(f_text.splitlines()), len(p_text.splitlines())) > MAX_BLOCK_LINES:
            skipped[f"function over {MAX_BLOCK_LINES} lines"] += 1
            continue
        menu = []
        for d in (u for u in us if u["kind"] == "decoy"):
            t = _transplant(f_text, p_text, d["snippet"], d["bug_lines"][0])
            if t:
                (fb, fl), (bb, bl) = t
                menu.append({"family": d["family"], "desc": d.get("decoy", d["family"]),
                             "fixed": {"block": fb, "line": fl}, "buggy": {"block": bb, "line": bl}})
        if not menu:
            skipped["no decoy usable in both versions"] += 1
            continue
        pool[bug_id.split("@")[0]].append({"bug_id": bug_id, "file": src, "fixed": f_text, "buggy": p_text,
                                           "real_lines": real["bug_lines"], "menu": menu})

    rng = random.Random(args.seed)
    units, k_cycle = [], 0
    for repo, bugs in sorted(pool.items()):
        if len(bugs) < BLOCKS:
            skipped[f"repo with < {BLOCKS} usable bugs"] += len(bugs)
            continue
        seen = set()
        for rnd in range(ROUNDS):
            order = bugs[:]
            rng.shuffle(order)
            for g in range(len(order) // BLOCKS):
                group = order[g * BLOCKS:(g + 1) * BLOCKS]
                key = tuple(sorted(b["bug_id"] for b in group))
                if key in seen:
                    continue
                seen.add(key)
                k = KS[k_cycle % len(KS)]
                k_cycle += 1
                units.append(_build_unit(f"cal-{repo}-{rnd}-{g}", repo, group, set(rng.sample(range(BLOCKS), k)), k))

    out = Path(args.out)
    out.write_text("".join(json.dumps(u) + "\n" for u in units))
    print(f"wrote {len(units)} units to {out}")
    print(f"  by k: {dict(sorted(Counter(u['k'] for u in units).items()))}")
    print(f"  by repo: {dict(Counter(u['repo'] for u in units))}")
    print(f"  bugs used: {len({b['bug_id'] for u in units for b in u['blocks']})}; "
          f"decoys on the menu per unit: {dict(sorted(Counter(sum(len(b['decoys']) for b in u['blocks']) for u in units).items()))}")
    print(f"  lines per unit: median {sorted(u['lines'] for u in units)[len(units) // 2]}, max {max(u['lines'] for u in units)}")
    print(f"  bugs left out: {dict(skipped)}")


def _assemble(parts):
    """Join (header, block text) parts into one file; returns the text and each block's first line."""
    lines, starts = [], []
    for header, text in parts:
        if lines:
            lines.append("")
        lines.append(header)
        starts.append(len(lines) + 1)
        lines.extend(text.splitlines())
    return "\n".join(lines) + "\n", starts


def _build_unit(unit_id, repo, group, buggy_idx, k):
    forms = ["buggy" if i in buggy_idx else "fixed" for i in range(len(group))]
    headers = [f"# --- {b['file']} ---" for b in group]
    original, starts = _assemble([(h, b[f]) for h, b, f in zip(headers, group, forms)])
    blocks = []
    for b, f, h, s in zip(group, forms, headers, starts):
        blocks.append({"bug_id": b["bug_id"], "file": b["file"], "form": f, "header": h, "text": b[f], "start": s,
                       "real_lines": [s + ln - 1 for ln in b["real_lines"]] if f == "buggy" else [],
                       "decoys": [{"family": d["family"], "desc": d["desc"], **d[f]} for d in b["menu"]]})
    split = "dev" if int(hashlib.sha256(unit_id.encode()).hexdigest(), 16) % 100 < DEV_SHARE * 100 else "test"
    return {"unit_id": unit_id, "repo": repo, "split": split, "k": k, "filename": f"{repo}_change.py",
            "lines": original.count("\n"), "original": original, "blocks": blocks}


def build_copies(unit: dict, flagged: set[int]) -> list[dict]:
    """Seeded copies for one unit, after its original was reviewed. Like the pipeline, a decoy is never put
    on a line the original review flagged (+-1). Copy i takes, per function, the i-th menu decoy whose line is
    free; functions without a free decoy stay unchanged in that copy."""
    copies, used = [], defaultdict(set)
    for ci in range(COPIES):
        parts, planted = [], []
        for bi, b in enumerate(unit["blocks"]):
            choice = None
            for di, d in enumerate(b["decoys"]):
                if di in used[bi] or (b["start"] + d["line"] - 1) in flagged:
                    continue
                choice = di
                break
            if choice is None:
                parts.append((b["header"], b["text"]))
                planted.append(None)
            else:
                used[bi].add(choice)
                parts.append((b["header"], b["decoys"][choice]["block"]))
                planted.append(b["decoys"][choice])
        text, starts = _assemble(parts)
        decoys = [{"bug_id": b["bug_id"], "family": d["family"], "desc": d["desc"], "line": s + d["line"] - 1}
                  for b, d, s in zip(unit["blocks"], planted, starts) if d is not None]
        if decoys:
            copies.append({"name": f"copy-{chr(65 + ci)}", "text": text, "decoys": decoys})
    return copies


# =========================================================================================== shared

def load_units(path=UNITS, split="all", limit=0):
    units = [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
    if split != "all":
        units = [u for u in units if u["split"] == split]
    return units[:limit] if limit else units


def _flagged(findings) -> set[int]:
    out = set()
    for f in findings:
        if f["end_line"] - f["start_line"] + 1 <= MAX_SPAN:
            out.update(range(f["start_line"] - 1, f["end_line"] + 2))
    return out


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def _reviewers(panel: str):
    from bugcensus.config import registry
    from bugcensus.review import LLMReviewer

    reg = registry()
    names = [n.strip() for n in panel.split(",") if n.strip()]
    unknown = [n for n in names if n not in reg]
    if unknown:
        sys.exit(f"unknown reviewers {unknown}; known: {list(reg)}")
    return [LLMReviewer(reg[n], usage_log=ROOT / "logs" / "usage.jsonl") for n in names]


def _plan_text(units, specs, fw_tps: float, fw_price: float, calls_per_unit: float = 1 + COPIES) -> tuple[str, float]:
    """Calls, rough tokens, time and cost per reviewer. No model is called."""
    calls = round(len(units) * calls_per_unit)
    in_tokens = sum(len(u["original"]) for u in units) / 3.6 * calls_per_unit + 450 * calls
    lines, total = [f"{len(units)} units -> about {calls} review calls per reviewer (~{in_tokens / 1e6:.2f}M input tokens each)"], 0.0
    for s in specs:
        out = OUT_TOKENS.get(s.name) or OUT_TOKENS.get(s.provider, 5000)
        out_total = out * calls
        if s.provider == "meta":
            cost = META_PER_CALL.get(s.name, 0.05) * calls * 1.5   # units are ~3x the Oct 26 inputs
            lines.append(f"  {s.name:11s} Meta API   ~${cost:,.2f} in credits (Oct 26 per-call average, +50% for larger inputs)")
            total += cost
        elif s.provider == "fireworks":
            hours = out_total / fw_tps / 3600 + 0.15        # + cold start and the slow tail
            cost = hours * fw_price
            lines.append(f"  {s.name:11s} Fireworks  ~{hours:.1f} GPU-hours, ~${cost:,.2f} at {fw_tps:.0f} output tok/s overall "
                         f"(assumed until `bench` measures it), ${fw_price:.2f}/h")
            total += cost
        elif s.provider == "mlx-local":
            lines.append(f"  {s.name:11s} local MLX  free, ~{out_total / LOCAL_TPS / 3600:.0f} hours on this Mac (one call at a time)")
        else:
            lines.append(f"  {s.name:11s} {s.provider:10s} cost not measured")
    lines.append(f"  rough total: ${total:,.2f} (could be off by +-50%)")
    return "\n".join(lines), total


def _confirm(text: str, assume_yes: bool) -> None:
    print(text)
    if assume_yes:
        return
    if input("Type 'yes' to start: ").strip() != "yes":
        sys.exit("Cancelled; nothing was called.")


def _review_jobs(jobs, out: Path, workers: int):
    """Run (unit, version, text, reviewer) jobs, appending one JSON line per call to `out`."""
    from bugcensus.config import describe

    if not jobs:
        return
    t0, n = time.time(), 0

    def one(job):
        u, name, text, r = job
        res = r.review(u["filename"], text, f"{u['unit_id']}|{name}")
        spec = getattr(r, "spec", None)
        return {"unit_id": u["unit_id"], "version": name, "reviewer": r.name,
                "model": describe(spec) if spec else {"reviewer": r.name, "model_id": r.name, "provider": "fake"},
                "findings": [{"start_line": f.start_line, "end_line": f.end_line, "category": f.category,
                              "explanation": f.explanation} for f in res.findings],
                "input_tokens": res.input_tokens, "output_tokens": res.output_tokens,
                "seconds": round(res.seconds, 1), "finish_reason": getattr(res, "finish_reason", None),
                "error": res.error, "ts": time.time()}

    with out.open("a") as fh, ThreadPoolExecutor(max_workers=workers) as pool:
        for fut in as_completed([pool.submit(one, j) for j in jobs]):
            row = fut.result()
            fh.write(json.dumps(row) + "\n")
            fh.flush()
            n += 1
            if row["error"] or n % 10 == 0 or n == len(jobs):
                eta = (time.time() - t0) / n * (len(jobs) - n)
                print(f"  {n}/{len(jobs)}  eta {eta / 60:.0f} min" + (f"  ERROR {row['error'][:120]}" if row["error"] else ""),
                      flush=True)


def execute(units, reviewers, exp: Path, workers: int, on_copies=None) -> None:
    """Two phases, resumable: originals, then copies built from what the originals flagged."""
    exp.mkdir(parents=True, exist_ok=True)
    reviews_path, copies_path = exp / "reviews.jsonl", exp / "copies.jsonl"
    names = {r.name for r in reviewers}

    def done_map():
        got = defaultdict(dict)
        for r in _read_jsonl(reviews_path):
            if r["error"] is None:
                got[(r["unit_id"], r["version"])][r["reviewer"]] = r
        return got

    got = done_map()
    jobs = [(u, "original", u["original"], r) for u in units for r in reviewers if r.name not in got[(u["unit_id"], "original")]]
    print(f"phase 1: {len(jobs)} reviews of originals")
    _review_jobs(jobs, reviews_path, workers)

    got = done_map()
    copies = {c["unit_id"]: c for c in _read_jsonl(copies_path)}
    new = []
    for u in units:
        orig = got[(u["unit_id"], "original")]
        if set(orig) != names or u["unit_id"] in copies:
            continue
        flagged = _flagged([f for row in orig.values() for f in row["findings"]])
        rec = {"unit_id": u["unit_id"], "panel": sorted(names), "flagged": sorted(flagged), "copies": build_copies(u, flagged)}
        copies[u["unit_id"]] = rec
        new.append(rec)
    with copies_path.open("a") as fh:
        for rec in new:
            fh.write(json.dumps(rec) + "\n")
    if on_copies:
        on_copies(copies)
    by_id = {u["unit_id"]: u for u in units}
    jobs = [(by_id[uid], c["name"], c["text"], r)
            for uid, rec in copies.items() if uid in by_id
            for c in rec["copies"] for r in reviewers if r.name not in got[(uid, c["name"])]]
    print(f"phase 2: {len(jobs)} reviews of seeded copies")
    _review_jobs(jobs, reviews_path, workers)
    missing = [u["unit_id"] for u in units if set(got[(u["unit_id"], "original")]) != names and u["unit_id"] not in copies]
    if missing:
        print(f"{len(missing)} units still lack a complete original review (errors?); run again to retry them")


# =========================================================================================== plan / bench / run

def plan(args):
    from bugcensus.config import registry

    units = load_units(args.units, args.split, args.limit_units)
    print(_plan_text(units, [registry()[n] for n in args.panel.split(",")], args.fw_tps, args.fw_price)[0])


def bench(args):
    """A few real calls (originals of the first units, run concurrently) to measure speed and reply length on
    the actual deployment, then project the full run. Costs a few minutes of GPU time."""
    from bugcensus.config import registry

    reviewers = _reviewers(args.panel)
    units = load_units(args.units, "all", args.n)
    jobs = [(u, r) for u in units for r in reviewers]
    _confirm(f"bench: {len(jobs)} review calls, {args.workers} at a time, to measure speed.", args.yes)
    t0, results = time.time(), []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futs = [pool.submit(r.review, u["filename"], u["original"], f"bench|{u['unit_id']}") for u, r in jobs]
        for f in as_completed(futs):
            res = f.result()
            results.append(res)
            print(f"  {res.reviewer}: {res.output_tokens or 0} output tokens in {res.seconds:.0f}s"
                  + (f"  ERROR {res.error}" if res.error else ""), flush=True)
    wall = time.time() - t0
    ok = [r for r in results if not r.error]
    if not ok:
        sys.exit("every bench call failed; check the deployment and FIREWORKS_GLIMMER_MODEL")
    tps = sum(r.output_tokens or 0 for r in ok) / wall
    per_call = sum(r.output_tokens or 0 for r in ok) / len(ok)
    print(f"\nmeasured: {tps:.0f} output tok/s overall with {args.workers} concurrent calls, "
          f"{per_call:.0f} output tokens per call, {wall:.0f}s wall, {len(results) - len(ok)} errors")
    specs = [registry()[n] for n in args.panel.split(",")]
    for s in specs:
        OUT_TOKENS[s.name] = per_call
    print("\nprojection for the full run:\n" + _plan_text(load_units(args.units), specs, tps, args.fw_price)[0])
    (ROOT / "data" / "calibration_bench.json").write_text(json.dumps({
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "panel": args.panel, "workers": args.workers,
        "calls": len(results), "errors": len(results) - len(ok), "output_tokens_per_sec": tps,
        "output_tokens_per_call": per_call, "wall_seconds": wall}, indent=2))
    print("saved data/calibration_bench.json; next: run with --fw-tps", round(tps))


def run(args):
    from bugcensus.config import registry

    reviewers = _reviewers(args.panel)
    units = load_units(args.units, args.split, args.limit_units)
    exp = EXP_DIR / args.tag
    done = {(r["unit_id"], r["version"], r["reviewer"]) for r in _read_jsonl(exp / "reviews.jsonl") if r["error"] is None}
    per_unit_left = []
    for u in units:
        left = sum((u["unit_id"], "original", r.name) not in done for r in reviewers)
        left += sum((u["unit_id"], f"copy-{chr(65 + i)}", r.name) not in done for i in range(COPIES) for r in reviewers)
        per_unit_left.append(left / max(len(reviewers), 1))
    todo = [u for u, n in zip(units, per_unit_left) if n > 0]
    if not todo:
        print(f"nothing left to review in {exp.relative_to(ROOT)}")
        return
    text, _ = _plan_text(todo, [registry()[r.name] for r in reviewers], args.fw_tps, args.fw_price,
                         calls_per_unit=sum(per_unit_left) / len(todo))
    _confirm(f"run '{args.tag}': {len(todo)} units still to finish ({len(done)} reviews already saved in "
             f"{exp.relative_to(ROOT)})\n{text}", args.yes)
    workers = 1 if any(r.spec.local for r in reviewers) else args.workers
    execute(units, reviewers, exp, workers)
    print(f"done. next: python scripts/calibration.py analyze --tag {args.tag} --name \"...\"")


# =========================================================================================== dry run

class TwoRateFake:
    """Offline reviewer for the dry run: catches each real bug with p_real and each decoy with p_decoy
    (deterministic), never anything else. It is told where they are through `truth` (dry run only)."""

    def __init__(self, name, p_real, p_decoy, seed=0):
        self.name, self.p_real, self.p_decoy, self.seed = name, p_real, p_decoy, seed
        self.truth: dict[str, list[tuple[int, str]]] = {}

    def review(self, filename, source, version, context=""):
        from bugcensus.review import Finding, ReviewResult

        found = []
        for line, kind in self.truth.get(version, []):
            p = self.p_real if kind == "real" else self.p_decoy
            if random.Random(f"{self.seed}|{self.name}|{version}|{line}").random() < p:
                found.append(Finding(self.name, line, line, "logic", "medium", f"fake {kind}"))
        return ReviewResult(self.name, version, found, seconds=0.0)


def dry_run(args):
    """The whole calibration with two fake reviewers. With equal catch rates for real bugs and decoys the
    estimate should come out calibrated; with --p-decoy above --p-real it should lean optimistic."""
    units = load_units(args.units)
    fakes = [TwoRateFake("fake-a", args.p_real, args.p_decoy, 1 + 10 * args.seed),
             TwoRateFake("fake-b", args.p_real * 0.8, args.p_decoy * 0.8, 2 + 10 * args.seed)]
    for u in units:
        for f in fakes:
            f.truth[f"{u['unit_id']}|original"] = [(b["real_lines"][0], "real") for b in u["blocks"] if b["real_lines"]]

    def on_copies(copies):
        for uid, rec in copies.items():
            for c in rec["copies"]:
                for f in fakes:
                    f.truth[f"{uid}|{c['name']}"] = [(d["line"], "decoy") for d in c["decoys"]]

    exp = EXP_DIR / args.tag
    for p in (exp / "reviews.jsonl", exp / "copies.jsonl"):
        if p.exists():
            p.unlink()
    execute(units, fakes, exp, workers=8, on_copies=on_copies)
    args.reviewers = None
    analyze(args)


# =========================================================================================== analyze

def _auc(scores, labels):
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    if not pos or not neg:
        return None
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))


def _group_count(findings):
    """Suspected bugs in the original = groups of overlapping tight findings (same rule as the pipeline)."""
    spans = sorted((f["start_line"], f["end_line"]) for f in findings if f["end_line"] - f["start_line"] + 1 <= MAX_SPAN)
    groups, end = 0, -10
    for a, b in spans:
        if a > end + 1:
            groups += 1
            end = b
        else:
            end = max(end, b)
    return groups


VARIANTS = {
    "flat": "Flat blind-rate prior (current product)",
    "pooled": "Pooled blind-rate prior (empirical Bayes from other repositories)",
}


def _size(o: dict, args) -> float:
    """Unit size w for the estimator. Calibration units have k chosen independently of their length, so by
    default every unit counts as size 1; --size lines uses changed lines / 100 like the product."""
    return o["lines"] / 100 if getattr(args, "size", "unit") == "lines" else 1.0


def _r(x, d=2):
    return "-" if x is None else round(x, d)


def _metrics(test: list[dict], variant: str) -> dict:
    """Calibration metrics of one estimator variant; confidence intervals resample whole repositories."""
    import numpy as np

    pred = np.array([o["pred"][variant]["expected_hidden"] for o in test])
    act = np.array([o["actual_hidden"] for o in test], float)
    pclean = np.array([o["pred"][variant]["p_clean"] for o in test])
    repos = sorted({o["repo"] for o in test})
    idx_by_repo = {r: [i for i, o in enumerate(test) if o["repo"] == r] for r in repos}
    rng = np.random.default_rng(0)

    def boot(stat, B=2000):
        vals = []
        for _ in range(B):
            pick = np.array([i for r in rng.choice(repos, len(repos)) for i in idx_by_repo[r]])
            v = stat(pick)
            if v is not None and np.isfinite(v):
                vals.append(v)
        return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))] if len(vals) > 50 else [None, None]

    def slope(ix):
        x, y = pred[ix], act[ix]
        return float(np.polyfit(x, y, 1)[0]) if len(ix) > 2 and np.ptp(x) > 1e-9 else None

    edges = sorted(set(np.quantile(pred, [0, .2, .4, .6, .8, 1.0]).round(6).tolist()))
    bins = []
    for bi, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
        last = bi == len(edges) - 2
        ix = np.where((pred >= lo) & ((pred <= hi) if last else (pred < hi)))[0]
        if not len(ix):
            continue
        sel = set(ix.tolist())
        ci = boot(lambda pick: float(np.mean(act[[i for i in pick if i in sel]])) if any(i in sel for i in pick) else None)
        bins.append({"lo": float(lo), "hi": float(hi), "n": int(len(ix)), "pred_mean": float(pred[ix].mean()),
                     "actual_mean": float(act[ix].mean()), "ci_low": ci[0], "ci_high": ci[1]})
    pbins = []
    for lo, hi in ((0, .5), (.5, .7), (.7, .9), (.9, 1.0001)):
        ix = np.where((pclean >= lo) & (pclean < hi))[0]
        if len(ix):
            pbins.append({"lo": lo, "hi": min(hi, 1.0), "n": int(len(ix)), "mean_p_clean": float(pclean[ix].mean()),
                          "frac_clean": float((act[ix] == 0).mean())})
    cleared = [i for i in range(len(test)) if pclean[i] >= 0.9]
    covered = [o["pred"][variant]["interval"][0] <= o["actual_hidden"] <= o["pred"][variant]["interval"][1] for o in test]
    return {
        "totals": {"predicted": float(pred.sum()), "actual": float(act.sum()),
                   "actual_over_predicted": float(act.sum() / pred.sum()) if pred.sum() else None,
                   "ci": boot(lambda p: float(act[p].sum() / pred[p].sum()) if pred[p].sum() else None)},
        "slope": {"value": slope(np.arange(len(test))), "ci": boot(slope)},
        "coverage90": {"rate": float(np.mean(covered)), "n": len(covered)},
        "clear_rule": {"cleared": len(cleared), "share_cleared": len(cleared) / len(test),
                       "false_clear_rate": float(np.mean(act[cleared] > 0)) if cleared else None},
        "auc_anything_hidden": {"estimate": _auc(list(pred), list(act > 0)),
                                "findings_count_baseline": _auc([o["found_unverified"] for o in test], list(act > 0))},
        "bins": bins, "pclean_bins": pbins,
    }


def analyze(args):
    import numpy as np

    exp = EXP_DIR / args.tag
    units = {u["unit_id"]: u for u in load_units(args.units)}
    rows = _read_jsonl(exp / "reviews.jsonl")
    copies = {c["unit_id"]: c for c in _read_jsonl(exp / "copies.jsonl")}
    if args.reviewers:
        keep = set(args.reviewers.split(","))
        rows = [r for r in rows if r["reviewer"] in keep]
    panel = sorted({r["reviewer"] for r in rows})
    by = defaultdict(dict)
    for r in rows:
        if r["error"] is None:
            by[(r["unit_id"], r["version"])][r["reviewer"]] = r
    models = {}
    for r in rows:
        models.setdefault(r["reviewer"], {**r.get("model", {}), "inferred": False})

    def complete(uid, version):
        return set(by.get((uid, version), {})) == set(panel)

    obs, skipped = [], Counter()
    for uid, u in units.items():
        if not complete(uid, "original") or uid not in copies:
            skipped["original not reviewed by the whole panel"] += 1
            continue
        orig = [f for x in by[(uid, "original")].values() for f in x["findings"]]
        found = sum(1 for b in u["blocks"] if b["form"] == "buggy" and caught(orig, b["real_lines"]))
        decoys = missed = 0
        for c in copies[uid]["copies"]:
            if not complete(uid, c["name"]):
                continue
            fs = [f for x in by[(uid, c["name"])].values() for f in x["findings"]]
            for d in c["decoys"]:
                decoys += 1
                missed += not caught(fs, [d["line"]])
        if not decoys:
            skipped["no seeded copy reviewed by the whole panel"] += 1
            continue
        obs.append({"unit_id": uid, "repo": u["repo"], "split": u["split"], "k": u["k"], "lines": u["lines"],
                    "found_verified": found, "found_unverified": _group_count(orig), "decoys": decoys, "missed": missed})
    if len({o["repo"] for o in obs}) < 2:
        sys.exit(f"only {len(obs)} complete units from <2 repositories; review more before analyzing")

    repos_all = sorted({o["repo"] for o in obs})
    variants = {}
    for vname in VARIANTS:
        priors = {}
        for repo in repos_all:
            others = [o for o in obs if o["repo"] != repo]
            qp = fit_q_prior([(o["decoys"], o["missed"]) for o in others]) if vname == "pooled" else (1.0, 1.0)
            pr = fit_prior([(o["found_verified"], o["decoys"], o["missed"], _size(o, args)) for o in others],
                           min_units=20, q_prior=qp)
            priors[repo] = pr
        preds = {}
        for o in obs:
            est = census(o["found_verified"], o["decoys"], o["missed"], size=_size(o, args), prior=priors[o["repo"]], seed=0)
            preds[o["unit_id"]] = {"expected_hidden": est.expected_hidden, "p_clean": est.p_clean,
                                   "interval": list(est.interval), "status": est.status, "q_mean": est.q_mean}
        variants[vname] = (priors, preds)
    for o in obs:
        o["actual_hidden"] = o["k"] - o["found_verified"]
        o["pred"] = {v: variants[v][1][o["unit_id"]] for v in VARIANTS}

    test = obs if args.split == "all" else [o for o in obs if o["split"] == args.split]
    if len(test) < 5:
        sys.exit(f"only {len(test)} complete units; review more before analyzing")
    calls = [r for r in rows if r["unit_id"] in {o["unit_id"] for o in obs}]
    result = {
        "schema_version": 2, "kind": "calibration", "name": args.name, "tag": args.tag,
        "analyzed_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "units_file": str(Path(args.units).relative_to(ROOT)) if Path(args.units).is_absolute() else args.units,
        "dry_run": bool(args.dry), "models": [models[r] for r in panel],
        "design": {"blocks": BLOCKS, "rounds": ROUNDS, "ks": list(KS), "copies": COPIES, "max_span": MAX_SPAN,
                   "max_block_lines": MAX_BLOCK_LINES, "evaluated_on": args.split, "size": args.size,
                   "prior": "cross-fitted: each repository's units use priors fitted on the other repositories"},
        "n_units": len(test), "n_by_k": {str(k): int(sum(o["k"] == k for o in test)) for k in KS},
        "repos": len({o["repo"] for o in test}), "skipped": dict(skipped),
        "decoys_per_unit": float(np.mean([o["decoys"] for o in test])),
        "decoy_miss_rate": float(sum(o["missed"] for o in test) / max(sum(o["decoys"] for o in test), 1)),
        "calls": {"total": len(calls), "errors": sum(r["error"] is not None for r in calls),
                  "output_tokens": sum(r["output_tokens"] or 0 for r in calls)},
        "variants": [],
        "units": test,
        "notes": ["Actual hidden counts only the k known bugs; fixed functions may hide others, so actual is a lower bound.",
                  "Decoys were test-validated on the fixed version of each function.",
                  f"Each bug appears in up to {ROUNDS} units; confidence intervals resample whole repositories."],
    }
    print(f"\n{len(test)} units, {result['repos']} repositories, panel {panel}, "
          f"{result['decoys_per_unit']:.1f} decoys per unit, {result['decoy_miss_rate']:.0%} of decoys missed by all")
    for vname in VARIANTS:
        m = _metrics(test, vname)
        m["name"], m["label"] = vname, VARIANTS[vname]
        m["priors_by_repo"] = {r: {"alpha": p.alpha, "beta": p.beta, "a_q": p.a_q, "b_q": p.b_q}
                               for r, p in variants[vname][0].items()}
        result["variants"].append(m)
        t, cr, a = m["totals"], m["clear_rule"], m["auc_anything_hidden"]
        fcr = "-" if cr["false_clear_rate"] is None else f"{cr['false_clear_rate']:.0%}"
        print(f"\n[{VARIANTS[vname]}]")
        print(f"  total hidden: predicted {t['predicted']:.1f}, actual {t['actual']:.0f}; actual/predicted "
              f"{_r(t['actual_over_predicted'])} (95% CI {_r(t['ci'][0])}-{_r(t['ci'][1])})")
        print(f"  slope {_r(m['slope']['value'])} (CI {_r(m['slope']['ci'][0])}-{_r(m['slope']['ci'][1])}); "
              f"90% interval coverage {m['coverage90']['rate']:.0%}")
        print(f"  Clear rule: cleared {cr['cleared']} ({cr['share_cleared']:.0%}), false-clear rate {fcr}")
        print(f"  AUC for 'anything hidden': estimate {_r(a['estimate'])}, findings-count baseline {_r(a['findings_count_baseline'])}")
        for bn in m["bins"]:
            print(f"    predicted {bn['pred_mean']:.2f} -> actual {bn['actual_mean']:.2f}  (n={bn['n']})")
    if args.dry:
        result["notes"].insert(0, "DRY RUN: fake reviewers, no models. Checks the pipeline and the math only.")
    slug = re.sub(r"[^a-z0-9]+", "_", args.name.lower()).strip("_")[:60]
    path = ROOT / "data" / f"calibration_{slug}.json"
    path.write_text(json.dumps(result, indent=2))
    print(f"wrote {path.relative_to(ROOT)}")
    if not args.no_push:
        from bugcensus.cli import _push

        _push(result, "calibration")


# =========================================================================================== main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("prepare", help="build calibration units (git only, no models)")
    p.add_argument("--realism-units", default=str(ROOT / "data" / "realism_units.jsonl"))
    p.add_argument("--bugs", default=f"{ROOT / 'data' / 'bugs.jsonl'},{ROOT / 'data' / 'candidates2.jsonl'}")
    p.add_argument("--raw", default=f"{ROOT / 'data' / 'raw'},~/raw2", help="comma list of folders with repo clones")
    p.add_argument("--out", default=str(UNITS))
    p.add_argument("--seed", type=int, default=0)
    p.set_defaults(func=prepare)

    def costs(s):
        s.add_argument("--fw-tps", type=float, default=float(os.getenv("FIREWORKS_TOKENS_PER_SEC", "400")),
                       help="overall output tokens/s on the Fireworks deployment (bench measures it)")
        s.add_argument("--fw-price", type=float, default=float(os.getenv("FIREWORKS_PRICE_PER_HOUR", "8")))

    for name, fn in (("plan", plan), ("run", run)):
        s = sub.add_parser(name)
        s.add_argument("--panel", required=True, help="e.g. spark,glimmer_fw")
        s.add_argument("--units", default=str(UNITS))
        s.add_argument("--split", default="all", choices=["all", "dev", "test"])
        s.add_argument("--limit-units", type=int, default=0, help="only the first N units (pilot)")
        costs(s)
        if name == "run":
            s.add_argument("--tag", required=True, help="experiment name; results go to data/calibration/<tag>/")
            s.add_argument("--workers", type=int, default=8, help="concurrent calls (hosted and Fireworks)")
            s.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
        s.set_defaults(func=fn)

    b = sub.add_parser("bench", help="a few real calls to measure speed on the deployment")
    b.add_argument("--panel", required=True)
    b.add_argument("--units", default=str(UNITS))
    b.add_argument("--n", type=int, default=8, help="units whose original is reviewed")
    b.add_argument("--workers", type=int, default=8)
    b.add_argument("--yes", action="store_true")
    costs(b)
    b.set_defaults(func=bench)

    def analysis_args(s):
        s.add_argument("--units", default=str(UNITS))
        s.add_argument("--split", default="all", choices=["all", "dev", "test"])
        s.add_argument("--no-push", action="store_true", help="don't send results to the dashboard")
        s.add_argument("--size", default="unit", choices=["unit", "lines"],
                       help="estimator size per unit: 1 (default; k does not depend on length here) or lines/100")

    a = sub.add_parser("analyze")
    a.add_argument("--tag", required=True)
    a.add_argument("--name", required=True, help="shown in the dashboard, e.g. 'Spark + Glimmer (Fireworks)'")
    a.add_argument("--reviewers", default=None, help="only these reviewers, e.g. glimmer_fw")
    analysis_args(a)
    a.set_defaults(func=analyze, dry=False)

    d = sub.add_parser("dry-run", help="the whole calibration with fake reviewers (no model calls)")
    d.add_argument("--p-real", type=float, default=0.8, help="fake catch rate for real bugs")
    d.add_argument("--p-decoy", type=float, default=0.8, help="fake catch rate for decoys")
    d.add_argument("--seed", type=int, default=0, help="changes which bugs and decoys the fakes catch")
    d.add_argument("--tag", default=None)
    d.add_argument("--name", default=None)
    analysis_args(d)
    d.set_defaults(func=dry_run, dry=True)

    args = ap.parse_args()
    if args.cmd == "dry-run":
        args.tag = args.tag or f"dryrun_r{round(args.p_real * 100)}_d{round(args.p_decoy * 100)}" + (f"_s{args.seed}" if args.seed else "")
        args.name = args.name or (f"Dry run: fake reviewers (real bugs {args.p_real:.0%}, decoys {args.p_decoy:.0%})"
                                  + (f", seed {args.seed}" if args.seed else ""))
    args.func(args)


if __name__ == "__main__":
    main()
