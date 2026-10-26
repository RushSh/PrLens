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
from .match import caught_by, covers, dedupe
from .review import Finding, ReviewResult, Reviewer
from .seed import SeededCopy, make_copies, valid_decoys


def run_census(path: str | Path, reviewers: list[Reviewer], line_ranges: list[tuple[int, int]] | None = None,
               n_copies: int = 2, per_copy: int = 5, prior: Prior | None = None, verified_found: int | None = None,
               seed: int = 0, out_dir: Path | None = Path("runs")) -> dict:
    path = Path(path)
    source = path.read_text()
    filename = path.name
    t0 = time.time()

    decoys = valid_decoys(source, line_ranges, seed=seed)
    copies: list[SeededCopy] = make_copies(source, decoys, n_copies=n_copies, per_copy=per_copy, seed=seed)

    # Test harness hook only: fake reviewers may be told where planted bugs are.
    for r in reviewers:
        if hasattr(r, "truth"):
            for c in copies:
                r.truth.setdefault(c.name, []).extend(d.final_line for d in c.decoys)

    jobs = [(r, "original", source) for r in reviewers] + [(r, c.name, c.source) for c in copies for r in reviewers]
    with ThreadPoolExecutor(max_workers=8) as pool:
        results: list[ReviewResult] = list(pool.map(lambda j: j[0].review(filename, j[2], j[1]), jobs))

    by_version: dict[str, list[Finding]] = {}
    for res in results:
        by_version.setdefault(res.version, []).extend(res.findings)

    # decoys: caught or missed by every reviewer
    decoy_rows, missed = [], 0
    for c in copies:
        fs = by_version.get(c.name, [])
        for d in c.decoys:
            who = caught_by(d, fs)
            missed += not who
            decoy_rows.append({"copy": c.name, "decoy": d.describe(), "line_in_copy": d.final_line, "caught_by": who})
    n_decoys = sum(len(c.decoys) for c in copies)

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
    if n_decoys:
        est = census(found, n_decoys, missed, size=max(changed, 1) / 100.0, prior=prior, seed=seed)

    report = {
        "file": str(path), "changed_lines": changed, "reviewers": [r.name for r in reviewers],
        "decoys_planted": n_decoys, "decoys_missed_by_all": missed, "decoys": decoy_rows,
        "suspected_bugs": suspected, "found_counted": found,
        "found_is_verified": verified_found is not None,
        "extras_from_copies": extras,
        "estimate": asdict(est) if est else None,
        "errors": [f"{r.reviewer}/{r.version}: {r.error}" for r in results if r.error],
        "tokens": {"input": sum(r.input_tokens or 0 for r in results), "output": sum(r.output_tokens or 0 for r in results)},
        "seconds": round(time.time() - t0, 1),
    }
    if out_dir:
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"{path.stem}-{int(time.time())}.json").write_text(json.dumps(report, indent=2))
    return report


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
        lines.append(f"Status: {est['status']}")
    else:
        lines.append("Still hidden: not estimated (no valid decoys could be planted in this code)")
    lines.append(f"Decoys (audit): {rep['decoys_planted']} planted, "
                 f"{rep['decoys_planted'] - rep['decoys_missed_by_all']} caught, "
                 f"{rep['decoys_missed_by_all']} missed by every reviewer")
    for d in rep["decoys"]:
        lines.append(f"  [{'caught by ' + ', '.join(d['caught_by']) if d['caught_by'] else 'MISSED'}] {d['copy']}: {d['decoy']}")
    if rep["extras_from_copies"]:
        lines.append(f"Extra finds in seeded copies (not counted): {len(rep['extras_from_copies'])}")
    if rep["errors"]:
        lines.append("Errors: " + "; ".join(rep["errors"]))
    lines.append(f"Tokens: {rep['tokens']['input']} in / {rep['tokens']['output']} out; {rep['seconds']}s")
    return "\n".join(lines)
