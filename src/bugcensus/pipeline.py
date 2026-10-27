"""One census run on one file (day-1 unit of work; PRs and sweep modules reuse this).

Isolation rules enforced here:
- the file on disk is read once and never written; decoys live only in in-memory copies;
- every (reviewer, version) pair is a separate, fresh call with the identical prompt and file name;
- only findings from the ORIGINAL pass count toward bugs found (unequal-exposure rule);
- real-looking findings in seeded copies are reported as extras, never counted.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from .estimate import CensusResult, Prior, census
from .match import MAX_SPAN, caught_by, covers, dedupe, matching_findings, span
from .review import PROMPT, Finding, ReviewResult, Reviewer
from .seed import SeededCopy, make_copies, valid_decoys


def _run_jobs(jobs, filename: str) -> list[ReviewResult]:
    """Hosted reviewers run in parallel; a local model serves one request at a time, so its calls run in turn."""
    hosted = [j for j in jobs if not getattr(getattr(j[0], "spec", None), "local", False)]
    local = [j for j in jobs if getattr(getattr(j[0], "spec", None), "local", False)]

    def one(j) -> ReviewResult:
        res = j[0].review(filename, j[2], j[1])
        _progress(res)
        return res

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = pool.map(one, hosted)
        local_results = [one(j) for j in local]
        return list(futures) + local_results


def _progress(res: ReviewResult) -> None:
    """One line per finished review call on stderr (the dashboard shows it live in the job log)."""
    import sys

    detail = f"ERROR {res.error}" if res.error else f"{len(res.findings)} findings"
    # one write per line so lines from parallel reviewers never interleave
    sys.stderr.write(f"[{time.strftime('%H:%M:%S')}] {res.reviewer} reviewed {res.version}: {detail}, "
                     f"{res.output_tokens or 0} output tokens, {res.seconds:.0f}s\n")
    sys.stderr.flush()


def run_census(path: str | Path, reviewers: list[Reviewer], line_ranges: list[tuple[int, int]] | None = None,
               n_copies: int = 2, per_copy: int = 5, prior: Prior | None = None, verified_found: int | None = None,
               seed: int = 0, out_dir: Path | None = Path("runs")) -> dict:
    path = Path(path)
    source = path.read_text()
    filename = path.name
    t0 = time.time()
    run_id = uuid.uuid4().hex

    # Phase 1: review the original. Phase 2: plant decoys away from lines the original review
    # already flagged (a decoy on a flagged line would be "caught" just because a real bug is there),
    # then review the copies.
    import sys

    print(f"[{time.strftime('%H:%M:%S')}] reviewing {filename} with {', '.join(r.name for r in reviewers)}",
          file=sys.stderr, flush=True)
    results: list[ReviewResult] = _run_jobs([(r, "original", source) for r in reviewers], filename)
    flagged = sorted({ln for res in results for f in res.findings if span(f) <= MAX_SPAN
                      for ln in range(f.start_line - 1, f.end_line + 2)})

    decoys = [d for d in valid_decoys(source, line_ranges, seed=seed) if d.line not in flagged]
    copies: list[SeededCopy] = make_copies(source, decoys, n_copies=n_copies, per_copy=per_copy, seed=seed)

    # Test harness hook only: fake reviewers may be told where planted bugs are.
    for r in reviewers:
        if hasattr(r, "truth"):
            for c in copies:
                r.truth.setdefault(c.name, []).extend(d.final_line for d in c.decoys)

    print(f"[{time.strftime('%H:%M:%S')}] planted {sum(len(c.decoys) for c in copies)} decoys in "
          f"{len(copies)} copies; reviewing copies", file=sys.stderr, flush=True)
    results += _run_jobs([(r, c.name, c.source) for c in copies for r in reviewers], filename)

    by_version: dict[str, list[Finding]] = {}
    for res in results:
        by_version.setdefault(res.version, []).extend(res.findings)
    failed = {res.version for res in results if res.error}

    # decoys: caught or missed by every reviewer. A copy where any reviewer failed is left out:
    # its decoys were not seen by the full panel, so they say nothing about the panel's blind rate.
    decoy_rows, missed = [], 0
    for c in copies:
        if c.name in failed:
            for d in c.decoys:
                decoy_rows.append({**_decoy_fields(c.name, d), "caught_by": [], "not_reviewed": True,
                                   "matched": [], "too_wide": []})
            continue
        fs = by_version.get(c.name, [])
        for d in c.decoys:
            who = caught_by(d, fs)
            missed += not who
            line = d.final_line or d.line
            near = [f for f in fs if covers(f, line)]
            decoy_rows.append({**_decoy_fields(c.name, d), "caught_by": who, "not_reviewed": False,
                               "matched": [_brief(f) for f in matching_findings(d, fs)],
                               "too_wide": [_brief(f) for f in near if span(f) > MAX_SPAN]})
    n_decoys = sum(len(c.decoys) for c in copies if c.name not in failed)

    # real findings from the original pass, grouped into suspected bugs
    groups = dedupe(by_version.get("original", []))
    suspected = [{"lines": [min(f.start_line for f in g), max(f.end_line for f in g)],
                  "reviewers": sorted({f.reviewer for f in g}),
                  "explanations": [f.explanation for f in g][:3]} for g in groups]

    # extras: findings in copies that are not decoys and not already found in the original
    extras = []
    for c in copies:
        decoy_lines = [d.final_line for d in c.decoys]
        for g in dedupe(by_version.get(c.name, [])):
            f = g[0]
            if any(covers(x, dl) for x in g for dl in decoy_lines):
                continue
            extras.append({"copy": c.name, "lines": [f.start_line, f.end_line], "explanation": f.explanation})

    found = verified_found if verified_found is not None else len(groups)
    changed = sum(b - a + 1 for a, b in line_ranges) if line_ranges else len(source.splitlines())
    est: CensusResult | None = None
    if n_decoys and "original" not in failed:
        est = census(found, n_decoys, missed, size=max(changed, 1) / 100.0, prior=prior, seed=seed)

    report = {
        "schema_version": 2, "run_id": run_id, "kind": "census",
        "started_at": _iso(t0), "finished_at": _iso(time.time()),
        "git_sha": _git_sha(path), "prompt_sha": hashlib.sha256(PROMPT.encode()).hexdigest()[:12],
        "settings": {"n_copies": n_copies, "per_copy": per_copy, "seed": seed, "max_span": MAX_SPAN,
                     "line_ranges": [list(r) for r in line_ranges] if line_ranges else None},
        "models": [_model_info(r) for r in reviewers],
        "reviews": [{"reviewer": r.reviewer, "version": r.version, "findings": len(r.findings),
                     "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
                     "seconds": round(r.seconds, 1), "finish_reason": getattr(r, "finish_reason", None),
                     "error": r.error} for r in results],
        "source": source if len(source) < 200_000 else None,
        "file": str(path), "changed_lines": changed, "reviewers": [r.name for r in reviewers],
        "decoys_planted": n_decoys, "decoy_free_lines": flagged, "decoys_missed_by_all": missed, "decoys": decoy_rows,
        "suspected_bugs": suspected, "found_counted": found,
        "found_is_verified": verified_found is not None,
        "extras_from_copies": extras,
        "findings_by_version": {v: [_brief(f) for f in fs] for v, fs in by_version.items()},
        "estimate": asdict(est) if est else None,
        "verdict": _verdict(found, est),
        "errors": [f"{r.reviewer}/{r.version}: {r.error}" for r in results if r.error],
        "tokens": {"input": sum(r.input_tokens or 0 for r in results), "output": sum(r.output_tokens or 0 for r in results)},
        "seconds": round(time.time() - t0, 1),
    }
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        out = out_dir / f"{path.stem}-{int(time.time())}-{run_id[:6]}.json"
        out.write_text(json.dumps(report, indent=2))
        report["saved_to"] = str(out)
    return report


def _iso(ts: float) -> str:
    from datetime import datetime, timezone

    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _git_sha(path: Path) -> str | None:
    """Commit of the BugCensus code that produced the run ('+dirty' if uncommitted changes)."""
    here = Path(__file__).resolve().parent
    try:
        sha = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=here, capture_output=True,
                             text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--untracked-files=no"], cwd=here,
                               capture_output=True, text=True, timeout=5).stdout.strip()
        return (sha + ("+dirty" if dirty else "")) or None
    except Exception:
        return None


def _model_info(r) -> dict:
    spec = getattr(r, "spec", None)
    if spec is None:
        return {"reviewer": r.name, "model_id": r.name, "provider": "fake", "endpoint": None,
                "open_weights": False, "reasoning_effort": None, "max_tokens": None}
    from .config import describe

    return describe(spec)


def _decoy_fields(copy_name: str, d) -> dict:
    return {"copy": copy_name, "decoy": d.describe(), "kind": d.kind, "function": d.function,
            "line": d.line, "line_in_copy": d.final_line}


def _verdict(found: int, est: CensusResult | None) -> str:
    """The headline. CLEAR only when nothing was found AND nothing is likely hidden."""
    if est is None:
        return "NOT ESTIMATED"
    if found:
        return f"FIX {found} FOUND BUG{'S' if found > 1 else ''}"
    return est.status


def _brief(f: Finding) -> dict:
    return {"reviewer": f.reviewer, "lines": [f.start_line, f.end_line], "category": f.category,
            "explanation": f.explanation}


def format_report(rep: dict) -> str:
    lines = [f"BugCensus: {rep['file']} ({rep['changed_lines']} lines)",
             f"Reviewers: {', '.join(rep['reviewers'])}",
             f"Suspected bugs (original pass): {len(rep['suspected_bugs'])}"
             + ("" if rep["found_is_verified"] else "  [UNVERIFIED: verifier not run yet]")]
    for s in rep["suspected_bugs"]:
        lines.append(f"  - lines {s['lines'][0]}-{s['lines'][1]} ({', '.join(s['reviewers'])}): {s['explanations'][0][:100]}")
    est = rep["estimate"]
    if est:
        lo, hi = est["interval"]
        lines.append(f"Still hidden (estimate): {est['expected_hidden']:.2f} bugs (90% interval {lo}-{hi}), "
                     f"P(clean) {est['p_clean']:.0%}")
        if rep["found_counted"]:
            lines.append(f"Status: {rep['verdict']}; rest of the file: {est['status']} "
                         f"({'nothing else likely hidden' if est['status'] == 'CLEAR' else 'more may be hidden'})")
        else:
            lines.append(f"Status: {rep['verdict']}")
    elif any("/original:" in e for e in rep["errors"]):
        lines.append("Still hidden: not estimated (the review of the original failed; see Errors)")
    elif rep["decoys"]:
        lines.append("Still hidden: not estimated (every seeded copy's review failed; see Errors)")
    else:
        lines.append("Still hidden: not estimated (no valid decoys could be planted in this code)")
    skipped = sum(1 for d in rep["decoys"] if d.get("not_reviewed"))
    lines.append(f"Decoys (audit): {rep['decoys_planted']} counted"
                 + (f" ({skipped} more not counted: their copy's review failed)" if skipped else "") + ", "
                 f"{rep['decoys_planted'] - rep['decoys_missed_by_all']} caught, "
                 f"{rep['decoys_missed_by_all']} missed by every reviewer")
    for d in rep["decoys"]:
        if d.get('not_reviewed'):
            lines.append(f"  [NOT REVIEWED: review of this copy failed] {d['copy']}: {d['decoy']}")
            continue
        tag = 'caught by ' + ', '.join(d['caught_by']) if d['caught_by'] else 'MISSED'
        if not d['caught_by'] and d.get('too_wide'):
            tag += ' (only a too-wide finding covered it)'
        lines.append(f"  [{tag}] {d['copy']}: {d['decoy']}")
    if rep["extras_from_copies"]:
        lines.append(f"Extra finds in seeded copies (not counted): {len(rep['extras_from_copies'])}")
    if rep["errors"]:
        lines.append("Errors: " + "; ".join(rep["errors"]))
    lines.append(f"Tokens: {rep['tokens']['input']} in / {rep['tokens']['output']} out; {rep['seconds']}s")
    return "\n".join(lines)
