"""Harder, more realistic decoys, kept only if the bug fix's own tests catch them.

Why: the calibration run showed one-token decoys are far easier to spot than real bugs in multi-function
changes (panel 87% vs 67%). These decoys come from models instead of fixed mutation rules:

  index           build data/bug_fixes.jsonl: buggy and fixed function text per mined bug (git only)
  generate        a model (Spark by default) rewrites each fixed function with ONE subtle, realistic bug,
                  multi-line allowed (paid: --plan-only shows calls and cost; asks before calling)
  glimmer         Glimmer scores every token of each fixed function; where it found another token nearly as
                  plausible (a near-miss), that swap is a candidate (MLX on this Mac, or a Fireworks deployment)
  validate        keep a candidate only if the file parses and the fix's own tests FAIL on it (pytest exit 1),
                  i.e. it changes behaviour for inputs the project itself tests. Needs repos + test envs
                  (scripts/setup_envs.py). Writes data/decoys_validated_<source>.jsonl
  realism-units   realism units for bugs with new decoys: the real bug, the old rule-based decoys and the new
                  ones, so one realism check compares all three under the same prompt

Raw candidates: data/decoys_<source>_raw.jsonl. Validated decoys use the realism-unit format, so the realism
check and calibration (prepare --extra-decoys) take them directly.
"""
from __future__ import annotations

import argparse
import ast
import difflib
import io
import json
import math
import random
import shutil
import sys
import time
import tokenize
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from bugcensus.bugdata import INDEX, build_index, changed_lines, find_repo, load_index  # noqa: E402
from bugcensus.llm import chat, confirm, plan_line, spec  # noqa: E402

DATA = ROOT / "data"
MAX_CHANGED = 6           # model-written decoys may change at most this many lines


def _usable(index: dict, limit: int) -> list[dict]:
    """Single-function bugs (a decoy is put back into exactly one function in the file)."""
    rows = [b for b in index.values() if len(b["fixed_ranges"]) == 1]
    return rows[:limit] if limit else rows


def _append(path: Path, rows: list[dict]) -> None:
    with path.open("a") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")


def _done(path: Path, key="bug_id") -> set:
    if not path.exists():
        return set()
    return {json.loads(l)[key] for l in path.read_text().splitlines() if l.strip()}


WRAP = "if True:\n"   # lets an indented method (or any indented block) parse on its own


def parse(code: str) -> ast.Module:
    """ast.parse that also accepts an indented snippet (methods cut out of a class)."""
    try:
        return ast.parse(code)
    except (SyntaxError, IndentationError):
        if code[:1] in (" ", "\t"):
            return ast.parse(WRAP + code)
        raise


def _edit_ok(fixed: str, code: str) -> tuple[bool, str]:
    """A candidate must parse, keep the same functions, and change 1..MAX_CHANGED lines."""
    if code.strip() == fixed.strip():
        return False, "unchanged"
    try:
        new_tree, old_tree = parse(code), parse(fixed)
    except SyntaxError:
        return False, "does not parse"
    names = lambda t: sorted(n.name for n in ast.walk(t) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)))
    if names(new_tree) != names(old_tree):
        return False, "functions renamed, added or removed"
    n = len(changed_lines(fixed, code))
    if not 1 <= n <= MAX_CHANGED:
        return False, f"{n} lines changed"
    return True, ""


# =========================================================================================== index

def cmd_index(args):
    n, skipped = build_index(Path(args.realism_units), INDEX, raw_dirs=[Path(p).expanduser() for p in args.raw.split(",")])
    print(f"wrote {n} bugs to {INDEX.relative_to(ROOT)}; left out: {skipped}")


# =========================================================================================== generate (model-written)

GEN_PROMPT = """You are helping evaluate code reviewers. Below is a correct Python function from the {repo} project ({file}).

Write {n} different versions of it. Each version contains exactly ONE subtle, realistic bug of the kind developers
and AI coding assistants really make, for example: a wrong boundary or comparison, a missed edge case for a valid
input, using the wrong variable or attribute, a stale or partially updated value, an incorrect default, swapped
arguments, an early return or a skipped step, mishandled None or empty input, or a wrong library call.

Rules for every version:
- keep everything else exactly as it is (names, formatting, comments, docstrings);
- change at most {max_changed} lines;
- the code must still run: no syntax errors, no undefined names;
- do not add comments or anything else that points at the bug;
- the bug must change the behaviour for some valid input;
- make the {n} bugs different kinds, in different places where possible.

Return ONLY a JSON object:
{{"decoys": [{{"kind": "<short label>", "description": "<one sentence: what is wrong>", "code": "<the complete function with the bug>"}}]}}

Function:
```python
{fixed}```
"""


def cmd_generate(args):
    s = spec(args.model)
    bugs = _usable(load_index(), args.limit)
    out = DATA / f"decoys_llm_{args.model}_raw.jsonl"
    todo = [b for b in bugs if b["bug_id"] not in _done(out)]
    line, _ = plan_line(s, len(todo), out_tokens_per_call=2500 + 400 * args.per_bug, scale=1.2)
    confirm(f"generate: {len(todo)} bugs still to do ({len(bugs) - len(todo)} done) -> {out.relative_to(ROOT)}\n"
            f"one call per bug asking for {args.per_bug} decoys\n{line}", args.yes, args.plan_only)

    def one(b):
        prompt = GEN_PROMPT.format(repo=b["repo"], file=b["file"], n=args.per_bug, max_changed=MAX_CHANGED, fixed=b["fixed"])
        r = chat(s, prompt, purpose=f"decoys.generate|{b['bug_id']}")
        rows, reasons = [], Counter()
        data = r.json() if not r.error else None
        for i, d in enumerate((data or {}).get("decoys", [])[: args.per_bug]):
            code = str(d.get("code", ""))
            if code and not code.endswith("\n"):
                code += "\n"
            ok, why = _edit_ok(b["fixed"], code)
            if not ok:
                reasons[why] += 1
                continue
            rows.append({"bug_id": b["bug_id"], "cand": f"llm-{args.model}-{i}", "source": f"llm:{args.model}",
                         "family": "llm:" + str(d.get("kind", "other")).strip().lower().replace(" ", "_")[:30],
                         "description": str(d.get("description", ""))[:300], "code": code})
        return b, rows, reasons, r.error or (None if data else "no JSON in reply")

    total, reasons_all, t0 = 0, Counter(), time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n, fut in enumerate(as_completed([pool.submit(one, b) for b in todo]), 1):
            b, rows, reasons, err = fut.result()
            if err:
                print(f"  {b['bug_id']}: ERROR {err[:120]}", flush=True)
                continue
            _append(out, rows or [{"bug_id": b["bug_id"], "cand": None}])   # marks the bug done
            total += len(rows)
            reasons_all.update(reasons)
            if n % 10 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)} bugs, {total} usable candidates, {time.time() - t0:.0f}s", flush=True)
    print(f"done: {total} candidates; rejected before testing: {dict(reasons_all)}")
    print(f"next: python scripts/decoys.py validate --in {out.relative_to(ROOT)}")


# =========================================================================================== glimmer (token near-misses)

CODE_TOKENS = (tokenize.NAME, tokenize.OP, tokenize.NUMBER)
PREFERRED = {"<", "<=", ">", ">=", "==", "!=", "+", "-", "*", "/", "//", "%", "and", "or", "not", "is", "in",
             "True", "False", "None", "0", "1", "2", "-1", "min", "max", "any", "all", "break", "continue",
             "if", "elif", "while", "+=", "-=", "[", "]", ":", "len"}


def code_spans(code: str) -> list[tuple[int, int, str]]:
    """Character spans of code tokens (names, operators, numbers); strings, comments and docstrings excluded."""
    wrapped = code[:1] in (" ", "\t")
    text = WRAP + code if wrapped else code
    starts = [0]
    for line in text.splitlines(True):
        starts.append(starts[-1] + len(line))
    shift = len(WRAP) if wrapped else 0
    out = []
    try:
        for t in tokenize.generate_tokens(io.StringIO(text).readline):
            if t.type in CODE_TOKENS:
                a = starts[t.start[0] - 1] + t.start[1] - shift
                b = starts[t.end[0] - 1] + t.end[1] - shift
                if a >= 0:
                    out.append((a, b, t.string))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        pass
    return out


def token_candidates(code: str, scored, per_bug: int, lo: float = 0.03, hi: float = 0.6) -> list[dict]:
    """Near-miss swaps from a model's own token probabilities.

    `scored`: list of (start, end, actual_text, p_actual, [(alt_text, p_alt), ...]) for each model token.
    A candidate swaps a token that lies inside one code token for an alternative the model found plausible
    (lo <= p_alt <= hi): the kind of slip the model itself could make. Prefers operators, comparisons,
    constants and keywords over renames; the swap must still parse."""
    spans = code_spans(code)
    cands, seen = [], set()
    for start, end, actual, p_act, alts in scored:
        inside = [s for s in spans if s[0] <= start and end <= s[1]] or \
                 [s for s in spans if start <= s[0] and s[1] <= end and actual.strip() == s[2]]
        if not inside or not actual.strip():
            continue
        lead = actual[: len(actual) - len(actual.lstrip())]
        for alt, p_alt in alts:
            alt_s = alt.strip()
            if not alt_s or alt_s == actual.strip() or not (lo <= p_alt <= hi):
                continue
            if any(ch in alt_s for ch in "#\"'\n\\") or len(alt_s) > 20:
                continue
            new = code[:start] + lead + alt_s + code[end:]
            if new in seen:
                continue
            try:
                parse(new)
            except SyntaxError:
                continue
            seen.add(new)
            line = code[:start].count("\n") + 1
            pref = alt_s in PREFERRED or actual.strip() in PREFERRED
            cands.append({"code": new, "line": line, "from": actual.strip(), "to": alt_s, "p_alt": round(p_alt, 4),
                          "p_actual": round(p_act, 4), "score": p_alt * (2.0 if pref else 1.0)})
    cands.sort(key=lambda c: -c["score"])
    picked, lines_used = [], Counter()
    for c in cands:                                   # spread over the function: at most 2 per line
        if lines_used[c["line"]] >= 2:
            continue
        lines_used[c["line"]] += 1
        picked.append(c)
        if len(picked) >= per_bug * 3:               # extra, since tests will reject some
            break
    return picked


def mlx_scorer(model_path: str, top: int = 8):
    """Token log-probabilities from Glimmer on this Mac (mlx-lm)."""
    import mlx.core as mx
    import numpy as np
    from mlx_lm import load

    model, tok = load(model_path)
    hf = getattr(tok, "_tokenizer", tok)

    def score(text: str):
        enc = hf(text, return_offsets_mapping=True, add_special_tokens=False)
        ids, offs = enc["input_ids"], enc["offset_mapping"]
        bos = [hf.bos_token_id] if getattr(hf, "bos_token_id", None) is not None else []
        logits = model(mx.array(bos + ids)[None])[0]
        logp = np.array((logits - mx.logsumexp(logits, axis=-1, keepdims=True)).astype(mx.float32))
        out = []
        for i in range(len(ids)):
            pos = len(bos) + i - 1
            if pos < 0:
                continue
            row = logp[pos]
            top_ids = np.argpartition(-row, top)[:top]
            alts = [(hf.decode([int(t)]), float(math.exp(row[t]))) for t in top_ids if int(t) != ids[i]]
            a, b = offs[i]
            out.append((a, b, text[a:b], float(math.exp(row[ids[i]])), alts))
        return out

    return score


def fireworks_scorer(top: int = 5):
    """Token log-probabilities from the Glimmer deployment on Fireworks (completions API, echo + logprobs)."""
    from openai import OpenAI

    s = spec("glimmer_fw")
    client = OpenAI(api_key=s.api_key, base_url=s.base_url)

    def score(text: str):
        r = client.completions.create(model=s.model_id, prompt=text, max_tokens=1, echo=True, logprobs=top, temperature=0)
        lp = r.choices[0].logprobs
        out = []
        for i, (t, l, alts, off) in enumerate(zip(lp.tokens, lp.token_logprobs, lp.top_logprobs or [], lp.text_offset)):
            if i == 0 or l is None or off >= len(text):
                continue
            out.append((off, off + len(t), t, math.exp(l),
                        [(a, math.exp(v)) for a, v in (alts or {}).items() if a != t]))
        return out

    return score


def cmd_glimmer(args):
    bugs = _usable(load_index(), args.limit)
    out = DATA / f"decoys_glimmer_{args.backend}_raw.jsonl"
    todo = [b for b in bugs if b["bug_id"] not in _done(out)]
    if args.backend == "mlx":
        model_path = __import__("os").getenv("BUGCENSUS_GLIMMER_MODEL", "mlx-community/Muse-Glimmer-30B-4bit")
        text = (f"glimmer (this Mac, MLX): {len(todo)} bugs to score with {model_path}; free, one forward pass per "
                f"function (about 2-10 s each after the model loads; needs ~18 GB free memory; stop mlx_lm.server first "
                f"if memory is tight)")
    else:
        line, _ = plan_line(spec("glimmer_fw"), len(todo), out_tokens_per_call=1)
        text = (f"glimmer (Fireworks): {len(todo)} scoring calls (prompt only, one output token each); cost is GPU "
                f"time while the deployment is up (a few minutes)\n{line}")
    confirm(text + f"\n-> {out.relative_to(ROOT)}", args.yes, args.plan_only)

    score = mlx_scorer(model_path) if args.backend == "mlx" else fireworks_scorer()
    total, t0 = 0, time.time()
    for n, b in enumerate(todo, 1):
        try:
            cands = token_candidates(b["fixed"], score(b["fixed"]), args.per_bug)
        except Exception as exc:  # one bad function must not stop the batch
            print(f"  {b['bug_id']}: ERROR {type(exc).__name__}: {exc}", flush=True)
            continue
        rows = [{"bug_id": b["bug_id"], "cand": f"glimmer-{i}", "source": f"glimmer:{args.backend}",
                 "family": "glimmer:token", "description": f"`{c['from']}` -> `{c['to']}` (model p={c['p_alt']:.2f})",
                 "code": c["code"]} for i, c in enumerate(cands)]
        _append(out, rows or [{"bug_id": b["bug_id"], "cand": None}])
        total += len(rows)
        if n % 10 == 0 or n == len(todo):
            print(f"  {n}/{len(todo)} bugs, {total} candidates, {time.time() - t0:.0f}s", flush=True)
    print(f"next: python scripts/decoys.py validate --in {out.relative_to(ROOT)}")


# =========================================================================================== validate (tests)

def _install_cmds() -> dict[str, str]:
    cmds = {}
    for raw in (ROOT / "scripts" / "repos_all.txt").read_text().splitlines():
        if raw.strip() and not raw.startswith("#") and "|" in raw:
            url, cmd = (x.strip() for x in raw.split("|", 1))
            cmds[url] = cmd
    return cmds


def cmd_validate(args):
    from realism import ensure_env, run_tests, sh, test_node_ids

    index = load_index()
    src = Path(args.inp)
    source = src.stem.removeprefix("decoys_").removesuffix("_raw")
    out = DATA / f"decoys_validated_{source}.jsonl"
    log = DATA / f"decoys_validated_{source}.log.jsonl"          # every verdict, for the record
    done = {(r["bug_id"], r["cand"]) for r in map(json.loads, log.read_text().splitlines())} if log.exists() else set()
    cands = defaultdict(list)
    for line in src.read_text().splitlines():
        if line.strip():
            c = json.loads(line)
            if c.get("cand") and (c["bug_id"], c["cand"]) not in done and c["bug_id"] in index:
                cands[c["bug_id"]].append(c)
    bug_ids = sorted(cands)[: args.limit] if args.limit else sorted(cands)
    print(f"validate: {sum(len(cands[b]) for b in bug_ids)} candidates in {len(bug_ids)} bugs -> {out.relative_to(ROOT)}", flush=True)
    raw_dirs = [Path(p).expanduser() for p in args.raw.split(",")]
    envs, work = Path(args.envs).expanduser(), Path(args.work).expanduser()
    envs.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)
    installs = _install_cmds()
    kept_total = Counter()

    for bi, bug_id in enumerate(bug_ids, 1):
        b = index[bug_id]
        repo = find_repo(b["repo"], raw_dirs)
        venv = envs / f"venv-{b['repo']}"
        verdicts = []
        if not repo:
            print(f"  {bug_id}: no clone (run scripts/setup_envs.py)", flush=True)
            continue
        if not ensure_env(repo, venv, installs.get(b["repo_url"], "pip install -e . pytest")):
            print(f"  {bug_id}: test environment failed", flush=True)
            continue
        wt = work / f"wt-{b['repo']}"
        sh(f"git worktree remove --force {wt}", repo)
        shutil.rmtree(wt, ignore_errors=True)
        if sh(f"git worktree add -q --detach {wt} {b['sha']}", repo).returncode:
            print(f"  {bug_id}: could not check out {b['sha'][:10]}", flush=True)
            continue
        try:
            tests = test_node_ids(repo, b["sha"], b["test_files"])
            path = wt / b["file"]
            original = path.read_text()
            if run_tests(wt, venv, tests, timeout=args.timeout) != 0:
                print(f"  {bug_id}: the fix's tests do not pass here; skipped", flush=True)
                verdicts = [{"bug_id": bug_id, "cand": c["cand"], "kept": False, "why": "baseline fails"} for c in cands[bug_id]]
                continue
            lines = original.splitlines(True)
            a, e = b["fixed_ranges"][0]
            for c in cands[bug_id]:
                mutated = "".join(lines[: a - 1]) + c["code"] + "".join(lines[e:])
                try:
                    ast.parse(mutated)
                except SyntaxError:
                    verdicts.append({"bug_id": bug_id, "cand": c["cand"], "kept": False, "why": "file does not parse"})
                    continue
                path.write_text(mutated)
                rc = run_tests(wt, venv, tests, timeout=args.timeout)
                path.write_text(original)
                kept = rc == 1                       # tests ran and failed: behaviour changed
                why = {0: "tests still pass", 124: "tests timed out"}.get(rc, "tests failed" if kept else f"pytest exit {rc}")
                verdicts.append({"bug_id": bug_id, "cand": c["cand"], "kept": kept, "why": why})
                if kept:
                    first = changed_lines(b["fixed"], c["code"])
                    m_first = changed_lines(c["code"], b["fixed"])
                    _append(out, [{"bug_id": bug_id, "unit_id": f"{bug_id}:{c['cand']}:{b['file']}", "kind": "decoy",
                                   "family": c["family"], "file": b["file"], "snippet": c["code"],
                                   "bug_lines": [m_first[0] if m_first else first[0]], "decoy": c["description"],
                                   "source": c["source"]}])
                    kept_total[c["source"]] += 1
        finally:
            _append(log, verdicts)
            sh(f"git worktree remove --force {wt}", repo)
            shutil.rmtree(wt, ignore_errors=True)
        print(f"  {bi}/{len(bug_ids)} {bug_id}: kept {sum(v['kept'] for v in verdicts)} of {len(verdicts)} "
              f"({', '.join(sorted({v['why'] for v in verdicts if not v['kept']})) or 'all kept'})", flush=True)
    print(f"done: kept {dict(kept_total)} -> {out.relative_to(ROOT)}")


# =========================================================================================== realism units

def cmd_realism_units(args):
    new = [json.loads(l) for l in Path(args.decoys).read_text().splitlines() if l.strip()]
    bugs = {d["bug_id"] for d in new}
    base = [json.loads(l) for l in (DATA / "realism_units.jsonl").read_text().splitlines() if l.strip()]
    keep = [u for u in base if u["bug_id"] in bugs]
    name = Path(args.decoys).stem.removeprefix("decoys_validated_")
    out = DATA / f"realism_units_{name}.jsonl"
    rows = keep + new
    out.write_text("".join(json.dumps(r) + "\n" for r in rows))
    kinds = Counter("real" if u["kind"] == "real" else ("new decoy" if u in new else "rule-based decoy") for u in rows)
    print(f"wrote {len(rows)} units for {len(bugs)} bugs to {out.relative_to(ROOT)}: {dict(kinds)}")
    print(f"next: review them (Experiments > Review realism units), then analyze")


# =========================================================================================== main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    i = sub.add_parser("index", help="build data/bug_fixes.jsonl (git only)")
    i.add_argument("--realism-units", default=str(DATA / "realism_units.jsonl"))
    i.add_argument("--raw", default=f"{DATA / 'raw'},~/raw2")
    i.set_defaults(func=cmd_index)

    def paid(s):
        s.add_argument("--limit", type=int, default=0, help="only the first N bugs")
        s.add_argument("--plan-only", action="store_true", help="print calls and cost, call nothing")
        s.add_argument("--yes", action="store_true", help="skip the confirmation prompt")

    g = sub.add_parser("generate", help="model-written decoys (paid)")
    g.add_argument("--model", default="spark")
    g.add_argument("--per-bug", type=int, default=3)
    g.add_argument("--workers", type=int, default=6)
    paid(g)
    g.set_defaults(func=cmd_generate)

    t = sub.add_parser("glimmer", help="token near-miss decoys from Glimmer's probabilities")
    t.add_argument("--backend", choices=["mlx", "fireworks"], default="mlx")
    t.add_argument("--per-bug", type=int, default=4)
    paid(t)
    t.set_defaults(func=cmd_glimmer)

    v = sub.add_parser("validate", help="keep candidates the fix's tests catch")
    v.add_argument("--in", dest="inp", required=True)
    v.add_argument("--limit", type=int, default=0)
    v.add_argument("--raw", default=f"{DATA / 'raw'},~/raw2", help="folders with repository clones")
    v.add_argument("--envs", default=str(DATA / "envs"), help="folder for per-repository test environments")
    v.add_argument("--work", default=str(DATA / "work"), help="scratch folder for checkouts")
    v.add_argument("--timeout", type=int, default=60, help="seconds per test run")
    v.set_defaults(func=cmd_validate)

    r = sub.add_parser("realism-units", help="realism units comparing real bugs, rule-based and new decoys")
    r.add_argument("--decoys", required=True)
    r.set_defaults(func=cmd_realism_units)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
