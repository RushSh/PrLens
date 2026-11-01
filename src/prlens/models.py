"""prlens models [--json]: the configured models and whether each can be called right now (no model is called).

Ready means its API key is set; a local model (MLX) also has to answer on its endpoint. The dashboard's model
pickers read this list, so they never disagree with what a pipeline step would use.
"""
from __future__ import annotations

import argparse
import json
import urllib.request

from .config import effort_for, registry


def status() -> list[dict]:
    out = []
    for s in registry().values():
        ready, why = True, "key set"
        if s.local:
            try:
                urllib.request.urlopen(s.base_url.rstrip("/") + "/models", timeout=1.5).read(64)
                why = "local server is up"
            except Exception:
                ready, why = False, f"local server not reachable at {s.base_url}"
        elif not s.api_key:
            ready, why = False, f"{s.api_key_env} is not set"
        out.append({"reviewer": s.name, "model_id": s.model_id, "provider": s.provider,
                    "open_weights": s.open_weights, "reasoning_effort": effort_for(s), "ready": ready, "why": why})
    return out


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)
    rows = status()
    if args.json:
        print(json.dumps(rows))
        return
    for r in rows:
        print(f"{'ready' if r['ready'] else 'not ready':10s} {r['reviewer']:12s} {r['model_id']} ({r['provider']}): {r['why']}")
