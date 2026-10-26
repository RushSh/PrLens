"""Match reviewer findings to planted decoys, and deduplicate real findings.

Day 1: a decoy counts as caught if a finding's line range covers the decoy's line (+-tolerance).
TODO (Thu): add the stricter rule from the proposal: an LLM judge must agree the finding's
explanation describes the decoy itself, not something else on the same line.
"""
from __future__ import annotations

from .review import Finding
from .seed import Decoy


def covers(f: Finding, line: int, tol: int = 1) -> bool:
    return f.start_line - tol <= line <= f.end_line + tol


def caught_by(decoy: Decoy, findings: list[Finding], tol: int = 1) -> list[str]:
    line = decoy.final_line or decoy.line
    return sorted({f.reviewer for f in findings if covers(f, line, tol)})


def dedupe(findings: list[Finding], tol: int = 1) -> list[list[Finding]]:
    """Group findings that point at overlapping lines: one group ~ one suspected bug."""
    groups: list[list[Finding]] = []
    for f in sorted(findings, key=lambda x: (x.start_line, x.end_line)):
        for g in groups:
            if any(f.start_line <= h.end_line + tol and h.start_line <= f.end_line + tol for h in g):
                g.append(f)
                break
        else:
            groups.append([f])
    return groups
