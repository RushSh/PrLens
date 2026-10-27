"""Model registry and settings, read from environment variables (.env supported)."""
from __future__ import annotations

import os
from dataclasses import dataclass

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # dotenv is optional for tests
    pass


@dataclass(frozen=True)
class ModelSpec:
    name: str          # short panel name, e.g. "spark"
    model_id: str      # provider model ID
    base_url: str
    api_key_env: str   # name of the env var holding the key
    open_weights: bool = False
    local: bool = False          # served on this machine (no key needed, one request at a time)
    provider: str = "meta"       # meta | baseten | mlx-local | fireworks (shown in run reports and the dashboard)

    @property
    def api_key(self) -> str | None:
        return os.getenv(self.api_key_env) or ("local" if self.local else None)


def registry() -> dict[str, ModelSpec]:
    meta_base = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
    baseten_base = os.getenv("BASETEN_API_BASE", "https://inference.baseten.co/v1")
    glimmer_base = os.getenv("GLIMMER_API_BASE", "http://localhost:8080/v1")
    fireworks_base = os.getenv("FIREWORKS_API_BASE", "https://api.fireworks.ai/inference/v1")
    return {
        "glimmer": ModelSpec("glimmer", os.getenv("BUGCENSUS_GLIMMER_MODEL", "mlx-community/Muse-Glimmer-30B-4bit"),
                             glimmer_base, "GLIMMER_API_KEY", open_weights=True, local=True, provider="mlx-local"),
        # Muse Glimmer 30B (BF16) on a Fireworks on-demand deployment. Set FIREWORKS_GLIMMER_MODEL to the
        # deployment printed by scripts/fireworks_glimmer.sh (accounts/<account>/deployments/<id>).
        "glimmer_fw": ModelSpec("glimmer_fw",
                                os.getenv("FIREWORKS_GLIMMER_MODEL", "accounts/fireworks/models/muse-glimmer-30b"),
                                fireworks_base, "FIREWORKS_API_KEY", open_weights=True, provider="fireworks"),
        "spark": ModelSpec("spark", os.getenv("BUGCENSUS_SPARK_MODEL", "muse-spark-1.3"),
                           meta_base, "META_API_KEY"),
        "wonder": ModelSpec("wonder", os.getenv("BUGCENSUS_WONDER_MODEL", "muse-wonder-1.0"),
                            meta_base, "META_API_KEY"),
        "spark_open": ModelSpec("spark_open",
                                os.getenv("BUGCENSUS_SPARK_OPEN_MODEL", "meta-models/muse-spark-open-1026"),
                                baseten_base, "BASETEN_API_KEY", open_weights=True, provider="baseten"),
    }


def panel_names() -> list[str]:
    raw = os.getenv("BUGCENSUS_PANEL", "spark,glimmer")
    return [p.strip() for p in raw.split(",") if p.strip()]


def reasoning_effort() -> str | None:
    value = os.getenv("BUGCENSUS_REASONING_EFFORT", "low").strip()
    return value or None


def local_max_tokens() -> int:
    """Generation budget for open-weight models (local MLX and Fireworks); their reasoning is long and
    servers default low."""
    return int(os.getenv("BUGCENSUS_LOCAL_MAX_TOKENS", "12000"))


def effort_for(spec: ModelSpec) -> str | None:
    """Reasoning effort sent to this model, or None if the request does not set one."""
    if spec.provider == "fireworks":
        return os.getenv("FIREWORKS_REASONING_EFFORT", "").strip() or None
    if spec.provider == "mlx-local":
        return None
    return reasoning_effort()


def max_tokens_for(spec: ModelSpec) -> int | None:
    """Reply budget. Glimmer on Fireworks reasons longer on bigger inputs (7.5k-12k+ tokens per review on
    calibration units) and the GPU is fast, so it gets its own, larger cap."""
    if spec.provider == "fireworks":
        return int(os.getenv("FIREWORKS_MAX_TOKENS", "24000"))
    return local_max_tokens() if spec.provider == "mlx-local" else None


def describe(spec: ModelSpec) -> dict:
    """What the run report records about a reviewer's model (no keys)."""
    from urllib.parse import urlparse

    return {"reviewer": spec.name, "model_id": spec.model_id, "provider": spec.provider,
            "endpoint": urlparse(spec.base_url).netloc, "open_weights": spec.open_weights,
            "reasoning_effort": effort_for(spec), "max_tokens": max_tokens_for(spec)}
