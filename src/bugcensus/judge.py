"""Judge matching: does a reviewer's finding describe a known bug (a real bug or a decoy)?

The line rule (a finding of <= 6 lines within +-1 line of the bug) is cheap but crude: it misses a finding that
describes the right bug a few lines away, and credits one that is near the bug but about something else. The judge
looks at the code, the bug (as a diff from the code under review to the correct code) and the nearby findings,
and says which findings describe that bug.

Fairness rules:
  - real bugs and decoys are judged by the same prompt, from the same kind of evidence (a diff);
  - only findings near the bug (within WINDOW lines, at most MAX_SPAN_JUDGE long) are shown;
  - a placebo share of calls swaps in a DIFFERENT bug's diff; the judge should say no. Its yes-rate is reported.
Verdicts are cached per (source, version, reviewer, bug) so analyses re-use them without new calls.
"""
from __future__ import annotations

import difflib
import hashlib
import json
from pathlib import Path

from .review import number_lines

WINDOW = 6
MAX_SPAN_JUDGE = 15
PLACEBO_SHARE = 0.15

PROMPT = """A code reviewer looked at the code below and reported findings. We know one specific bug is in this code.
The diff shows how the code under review differs from the correct code.

Code under review (line numbers on the left):
{excerpt}

The known bug (diff from the code under review to the correct code):
{diff}

Findings from the reviewer:
{findings}

Which findings describe THIS bug: the same wrong behaviour, even if worded differently or pointing a few lines
away? A finding about a different problem does not count, even if it is close by.
Return ONLY a JSON object: {{"matches": [<finding numbers>], "reason": "<one short sentence>"}}"""


def near(findings: list[dict], lines: list[int]) -> list[dict]:
    """Findings close enough to the bug to be worth judging."""
    out = []
    for f in findings:
        a, b = f["start_line"], f["end_line"]
        if b - a + 1 > MAX_SPAN_JUDGE:
            continue
        if any(a - WINDOW <= ln <= b + WINDOW for ln in lines):
            out.append(f)
    return out


def excerpt(text: str, lines: list[int], pad: int = 10) -> str:
    """Numbered lines around the bug, so the judge can relate findings' line numbers to the code."""
    all_lines = text.splitlines()
    lo = max(1, min(lines) - pad)
    hi = min(len(all_lines), max(lines) + pad)
    numbered = number_lines(text).splitlines()
    return "\n".join(numbered[lo - 1:hi])


def hunk_near(reviewed: str, correct: str, line: int, context: int = 2) -> str:
    """The diff hunk(s) of reviewed -> correct that touch the reviewed code near `line`."""
    out = []
    a, b = reviewed.splitlines(True), correct.splitlines(True)
    for group in difflib.SequenceMatcher(None, a, b, autojunk=False).get_grouped_opcodes(context):
        first, last = group[0][1] + 1, group[-1][2]
        if first - 3 <= line <= max(last, first) + 3:
            for tag, i1, i2, j1, j2 in group:
                if tag == "equal":
                    out += [" " + x for x in a[i1:i2]]
                else:
                    out += ["-" + x for x in a[i1:i2]] + ["+" + x for x in b[j1:j2]]
    return "".join(out) or "(no textual difference found near this line)"


def key(source: str, version: str, reviewer: str, target: str, placebo: bool = False) -> str:
    raw = f"{source}|{version}|{reviewer}|{target}|{'placebo' if placebo else 'real'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def is_placebo(k: str) -> bool:
    """Deterministic: about PLACEBO_SHARE of targets also get a placebo call."""
    return int(hashlib.sha256(("placebo" + k).encode()).hexdigest(), 16) % 1000 < PLACEBO_SHARE * 1000


def render(target: dict, findings: list[dict], diff: str | None = None) -> str:
    listed = "\n".join(f"{i}. lines {f['start_line']}-{f['end_line']}: {f.get('explanation') or ''}"
                       for i, f in enumerate(findings))
    return PROMPT.format(excerpt=excerpt(target["reviewed"], target["lines"]), diff=diff or target["diff"],
                         findings=listed)


def load_cache(path: Path) -> dict[str, dict]:
    if not path.exists():
        return {}
    return {r["key"]: r for r in map(json.loads, path.read_text().splitlines()) if r}


def cache_path(root: Path, source: str) -> Path:
    slug = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in source)[:80]
    return root / "data" / "judge" / f"{slug}.jsonl"


class Verdicts:
    """Look up judge verdicts during an analysis. Missing verdicts are counted, never guessed."""

    def __init__(self, root: Path, source: str):
        self.source = source
        self.cache = load_cache(cache_path(root, source))
        self.missing = 0

    def caught(self, version: str, reviewer: str, target_id: str, findings: list[dict], lines: list[int]) -> bool:
        cands = near(findings, lines)
        if not cands:
            return False
        v = self.cache.get(key(self.source, version, reviewer, target_id))
        if v is None:
            self.missing += 1
            return False
        return bool(v.get("matches"))
