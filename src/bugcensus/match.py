"""Match reviewer findings to planted decoys, and deduplicate real findings.

A decoy counts as caught if a finding of at most MAX_SPAN lines covers the decoy's line (+-tolerance).
Wide findings ("this whole function is wrong") would otherwise catch every decoy in their range by luck;
the same rule is used by scripts/realism.py.
TODO (Thu): add the stricter rule from the proposal: an LLM judge must agree the finding's
explanation describes the decoy itself, not something else on the same line.
"""
from __future__ import annotations

from .review import Finding
from .seed import Decoy


MAX_SPAN = 6   # findings longer than this don't count as pointing at a decoy


def covers(f: Finding, line: int, tol: int = 1) -> bool:
    return f.start_line - tol <= line <= f.end_line + tol


def span(f: Finding) -> int:
    return f.end_line - f.start_line + 1


def matching_findings(decoy: Decoy, findings: list[Finding], tol: int = 1, max_span: int = MAX_SPAN) -> list[Finding]:
    line = decoy.final_line or decoy.line
    return [f for f in findings if span(f) <= max_span and covers(f, line, tol)]


def caught_by(decoy: Decoy, findings: list[Finding], tol: int = 1, max_span: int = MAX_SPAN) -> list[str]:
    return sorted({f.reviewer for f in matching_findings(decoy, findings, tol, max_span)})


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
