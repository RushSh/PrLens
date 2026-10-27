"""One chat call to any configured model, with the same provider rules as the reviewers (JSON mode only
where supported, token caps for open-weight models, Fireworks cold-start retries) and usage logging.
Used by the decoy writer and the judge; reviews themselves go through review.LLMReviewer."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from .config import ModelSpec, effort_for, max_tokens_for, registry


@dataclass
class Reply:
    text: str                 # final answer only (reasoning channel removed)
    input_tokens: int | None
    output_tokens: int | None
    finish_reason: str | None
    seconds: float
    error: str | None = None

    def json(self) -> dict | None:
        """The first JSON object in the reply, or None."""
        t = self.text.strip()
        if t.startswith("```"):
            t = t.strip("`")
            t = t[t.find("\n") + 1:] if "\n" in t else t
        start, end = t.find("{"), t.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            return json.loads(t[start:end + 1])
        except json.JSONDecodeError:
            return None


def spec(name: str) -> ModelSpec:
    reg = registry()
    if name not in reg:
        raise SystemExit(f"unknown model {name!r}; known: {list(reg)}")
    return reg[name]


def chat(s: ModelSpec, prompt: str, purpose: str, max_tokens: int | None = None,
         usage_log: Path | None = Path("logs/usage.jsonl")) -> Reply:
    from openai import APIStatusError, OpenAI

    from .review import final_answer

    if not s.api_key:
        return Reply("", None, None, None, 0.0, f"{s.api_key_env} is not set")
    client = OpenAI(api_key=s.api_key, base_url=s.base_url)
    kwargs: dict = {}
    cap = max_tokens or max_tokens_for(s)
    if cap:
        kwargs["max_tokens"] = cap
    if s.provider in ("meta", "baseten"):
        kwargs["response_format"] = {"type": "json_object"}
    effort = effort_for(s)
    if effort:
        kwargs["reasoning_effort"] = effort
    t0 = time.time()
    deadline = t0 + 600
    while True:
        try:
            resp = client.chat.completions.create(model=s.model_id, messages=[{"role": "user", "content": prompt}], **kwargs)
            break
        except APIStatusError as exc:
            if s.provider == "fireworks" and exc.status_code == 503 and time.time() < deadline:
                time.sleep(15)
                continue
            return Reply("", None, None, None, time.time() - t0, f"{type(exc).__name__}: {exc}")
        except Exception as exc:  # network and the like: report, never crash a batch
            return Reply("", None, None, None, time.time() - t0, f"{type(exc).__name__}: {exc}")
    choice = resp.choices[0]
    usage = getattr(resp, "usage", None)
    r = Reply(final_answer(choice.message.content or ""), getattr(usage, "prompt_tokens", None),
              getattr(usage, "completion_tokens", None), getattr(choice, "finish_reason", None), time.time() - t0)
    if r.finish_reason == "length":
        r.error = f"reply cut off at the token limit ({r.output_tokens} tokens)"
    if usage_log:
        usage_log.parent.mkdir(parents=True, exist_ok=True)
        with usage_log.open("a") as f:
            f.write(json.dumps({"ts": time.time(), "model": s.model_id, "provider": s.provider, "reviewer": s.name,
                                "version": purpose, "error": r.error, "input_tokens": r.input_tokens,
                                "output_tokens": r.output_tokens, "seconds": round(r.seconds, 2)}) + "\n")
    return r


# Rough cost per call for plans (US$), from Oct 26-27 measurements; None = billed another way.
PER_CALL = {"spark": 0.017, "wonder": 0.09, "glimmer": 0.0}


def plan_line(s: ModelSpec, calls: int, out_tokens_per_call: int, scale: float = 1.0) -> tuple[str, float]:
    """One line for a --plan-only printout, and its dollar estimate."""
    if s.provider == "meta":
        cost = PER_CALL.get(s.name, 0.05) * calls * scale
        return f"  {s.name}: {calls} calls, ~${cost:,.2f} in Meta credits (rough)", cost
    if s.provider == "fireworks":
        import os

        tps = float(os.getenv("FIREWORKS_TOKENS_PER_SEC", "950"))
        hours = calls * out_tokens_per_call / tps / 3600 + 0.05
        cost = hours * float(os.getenv("FIREWORKS_PRICE_PER_HOUR", "8"))
        return f"  {s.name}: {calls} calls, ~{hours:.2f} GPU-hours, ~${cost:,.2f} (needs a running deployment)", cost
    if s.provider == "mlx-local":
        return f"  {s.name}: {calls} calls on this Mac, free, ~{calls * out_tokens_per_call / 17.7 / 3600:.1f} hours", 0.0
    return f"  {s.name}: {calls} calls, cost not measured", 0.0


def confirm(text: str, assume_yes: bool, plan_only: bool) -> None:
    """Print the plan; stop after it (--plan-only), or ask unless --yes."""
    import sys

    print(text, flush=True)
    if plan_only:
        sys.exit(0)
    if assume_yes:
        return
    if input("Type 'yes' to start: ").strip() != "yes":
        sys.exit("Cancelled; nothing was called.")
