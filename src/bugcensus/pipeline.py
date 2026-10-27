"""One census run on one file (day-1 unit of work; PRs and sweep modules reuse this).

Isolation rules enforced here:
- the file on disk is read once and never written; decoys live only in in-memory copies;
- every (reviewer, version) pair is a separate, fresh call with the identical prompt and file name;
- only findings from the ORIGINAL pass count toward bugs found (unequal-exposure rule);
- real-looking findings in seeded copies are reported as extras, never counted.
"""
from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path

from .estimate import CensusResult, Prior, census
from .match import MAX_SPAN, caught_by, covers, dedupe, matching_findings, span
from .review import Finding, ReviewResult, Reviewer
from .seed import SeededCopy, make_copies, valid_decoys


def _run_jobs(jobs, filename: str) -> list[ReviewResult]:
    """Hosted reviewers run in parallel; a local model serves one request at a time, so its calls run in turn."""
    hosted = [j for j in jobs if not getattr(getattr(j[0], "spec", None), "local", False)]
    local = [j for j in jobs if getattr(getattr(j[0], "spec", None), "local", False)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = pool.map(lambda j: j[0].review(filename, j[2], j[1]), hosted)
        local_results = [j[0].review(filename, j[2], j[1]) for j in local]
        return list(futures) + local_results


def run_census(path: str | Path, reviewers: list[Reviewer], line_ranges: list[tuple[int, int]] | None = None,
               n_copies: int = 2, per_copy: int = 5, prior: Prior | None = None, verified_found: int | None = None,
               seed: int = 0, out_dir: Path | None = Path("runs")) -> dict:
    path = Path(path)
    source = path.read_text()
    filename = path.name
    t0 = time.time()

    # Phase 1: review the original. Phase 2: plant decoys away from lines the original review
    # already flagged (a decoy on a flagged line would be "caught" just because a real bug is there),
    # then review the copies.
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
                decoy_rows.append({"copy": c.name, "decoy": d.describe(), "line_in_copy": d.final_line,
                                   "caught_by": [], "not_reviewed": True, "matched": [], "too_wide": []})
            continue
        fs = by_version.get(c.name, [])
        for d in c.decoys:
            who = caught_by(d, fs)
            missed += not who
            line = d.final_line or d.line
            near = [f for f in fs if covers(f, line)]
            decoy_rows.append({"copy": c.name, "decoy": d.describe(), "line_in_copy": d.final_line, "caught_by": who,
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
        (out_dir / f"{path.stem}-{int(time.time())}.json").write_text(json.dumps(report, indent=2))
    return report


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
