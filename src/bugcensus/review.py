"""Reviewers: send one version of the code to one model and get structured findings back.

Rules that keep the statistics valid (enforced by the pipeline, documented here):
- every call is a fresh context: no reviewer sees another's findings or another version;
- the original and the seeded copies get the identical prompt, settings and file name;
- nothing in the prompt mentions decoys.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Protocol

from .config import ModelSpec, local_max_tokens, reasoning_effort

PROMPT = """You are reviewing a code change before it is merged.
Find every bug in the code below: wrong results, crashes, missed edge cases, broken contracts,
misuse of APIs, wrong error handling, security problems. List ALL of them, not only the most important.

A bug is code that gives a wrong result, crashes or behaves insecurely for an input it is meant to
handle, judged by its name, docstring, comments and how the rest of the code uses it.
Do NOT report:
- missing input validation, type checks or defensive guards for inputs the code is not meant to accept;
- floating-point precision or rounding-mode remarks, unless the code clearly needs exact results;
- style, naming, formatting, documentation or performance issues.
Point each finding at the smallest line range that contains the bug (usually one to three lines).

Return ONLY a JSON object with this shape:
{{"findings": [{{"start_line": <int>, "end_line": <int>, "category": "<short label>",
  "severity": "low|medium|high", "explanation": "<one or two sentences>",
  "suggested_fix": "<short code or description>"}}]}}
If you find no bugs, return {{"findings": []}}.

File: {filename}
{context}
Code (line numbers on the left):
{numbered}
"""


@dataclass
class Finding:
    reviewer: str
    start_line: int
    end_line: int
    category: str = ""
    severity: str = ""
    explanation: str = ""
    suggested_fix: str = ""


@dataclass
class ReviewResult:
    reviewer: str
    version: str                   # "original" or "copy-A", "copy-B", ...
    findings: list[Finding] = field(default_factory=list)
    input_tokens: int | None = None
    output_tokens: int | None = None
    seconds: float = 0.0
    error: str | None = None


class Reviewer(Protocol):
    name: str

    def review(self, filename: str, source: str, version: str, context: str = "") -> ReviewResult: ...


def number_lines(source: str) -> str:
    return "\n".join(f"{i:4d} | {line}" for i, line in enumerate(source.splitlines(), start=1))


_FINAL_MARKERS = ("to=user<|message|>", "<|channel|>final<|message|>")
_SPECIAL = re.compile(r"<\|[a-z_]+\|>")


def final_answer(text: str) -> str:
    """Keep only the final answer when a model returns its reasoning channel too (e.g. Muse Glimmer
    served locally): everything after the last final-answer marker, with special tokens removed."""
    if not text:
        return ""
    for marker in _FINAL_MARKERS:
        if marker in text:
            text = text.rsplit(marker, 1)[1]
            break
    return _SPECIAL.sub("", text).strip()


def parse_findings(text: str, reviewer: str) -> list[Finding]:
    """Parse a model reply into findings. Tolerates code fences and prose around the JSON."""
    text = final_answer(text)
    if not text:
        return []
    candidates = [text]
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        candidates.insert(0, fence.group(1))
    brace = re.search(r"\{.*\}", text, re.S)
    if brace:
        candidates.append(brace.group(0))
    data = None
    for c in candidates:
        try:
            data = json.loads(c)
            break
        except (json.JSONDecodeError, TypeError):
            continue
    if not isinstance(data, dict):
        return []
    out = []
    for item in data.get("findings", []) or []:
        if not isinstance(item, dict):
            continue
        try:
            start = int(item.get("start_line", item.get("line", 0)))
            end = int(item.get("end_line", start))
        except (TypeError, ValueError):
            continue
        if start <= 0:
            continue
        out.append(Finding(reviewer=reviewer, start_line=start, end_line=max(start, end),
                           category=str(item.get("category", "")), severity=str(item.get("severity", "")),
                           explanation=str(item.get("explanation", "")),
                           suggested_fix=str(item.get("suggested_fix", ""))))
    return out


class LLMReviewer:
    """Any OpenAI-compatible endpoint: Meta Model API (Spark, Wonder) or Baseten (Spark Open)."""

    def __init__(self, spec: ModelSpec, usage_log: Path | None = Path("logs/usage.jsonl")):
        from openai import OpenAI

        if not spec.api_key:
            raise RuntimeError(f"{spec.api_key_env} is not set (needed for reviewer '{spec.name}')")
        self.spec = spec
        self.name = spec.name
        self.client = OpenAI(api_key=spec.api_key, base_url=spec.base_url)
        self.usage_log = usage_log

    def review(self, filename: str, source: str, version: str, context: str = "") -> ReviewResult:
        prompt = PROMPT.format(filename=filename, numbered=number_lines(source),
                               context=f"Context:\n{context}\n" if context else "")
        kwargs = {}
        effort = reasoning_effort()
        if self.spec.local:
            # local servers (mlx_lm.server) need an explicit generation budget and may not support
            # response_format; the parser handles reasoning text and fences.
            kwargs["max_tokens"] = local_max_tokens()
        else:
            kwargs["response_format"] = {"type": "json_object"}
            if effort:
                kwargs["reasoning_effort"] = effort
        t0 = time.time()
        try:
            resp = self.client.chat.completions.create(
                model=self.spec.model_id,
                messages=[{"role": "user", "content": prompt}],
                **kwargs,
            )
        except Exception as exc:  # report, don't crash the whole census
            return ReviewResult(self.name, version, error=f"{type(exc).__name__}: {exc}",
                                seconds=time.time() - t0)
        text = resp.choices[0].message.content or ""
        usage = getattr(resp, "usage", None)
        result = ReviewResult(self.name, version, parse_findings(text, self.name),
                              getattr(usage, "prompt_tokens", None), getattr(usage, "completion_tokens", None),
                              time.time() - t0)
        self._log(result)
        return result

    def _log(self, r: ReviewResult) -> None:
        if not self.usage_log:
            return
        self.usage_log.parent.mkdir(parents=True, exist_ok=True)
        with self.usage_log.open("a") as f:
            f.write(json.dumps({"ts": time.time(), "model": self.spec.model_id, "version": r.version,
                                "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
                                "seconds": round(r.seconds, 2)}) + "\n")


class FakeReviewer:
    """Offline reviewer for tests and --dry-run. Catches each decoy with a fixed probability,
    using a deterministic hash so runs are reproducible. Never sees which lines are decoys
    except through the `truth` hook, which only the test harness sets."""

    def __init__(self, name: str, catch_prob: float = 0.6, seed: int = 0):
        self.name = name
        self.catch_prob = catch_prob
        self.seed = seed
        self.truth: dict[str, list[int]] = {}   # version -> buggy lines (test harness only)

    def review(self, filename: str, source: str, version: str, context: str = "") -> ReviewResult:
        import random

        findings = []
        for line in self.truth.get(version, []):
            rng = random.Random(f"{self.seed}-{self.name}-{version}-{line}")
            if rng.random() < self.catch_prob:
                findings.append(Finding(self.name, line, line, "logic", "medium", "suspicious change"))
        return ReviewResult(self.name, version, findings)


def asdict_result(r: ReviewResult) -> dict:
    return asdict(r)
