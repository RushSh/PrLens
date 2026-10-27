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

    @property
    def api_key(self) -> str | None:
        return os.getenv(self.api_key_env) or ("local" if self.local else None)


def registry() -> dict[str, ModelSpec]:
    meta_base = os.getenv("META_API_BASE", "https://api.meta.ai/v1")
    baseten_base = os.getenv("BASETEN_API_BASE", "https://inference.baseten.co/v1")
    glimmer_base = os.getenv("GLIMMER_API_BASE", "http://localhost:8080/v1")
    return {
        "glimmer": ModelSpec("glimmer", os.getenv("BUGCENSUS_GLIMMER_MODEL", "mlx-community/Muse-Glimmer-30B-4bit"),
                             glimmer_base, "GLIMMER_API_KEY", open_weights=True, local=True),
        "spark": ModelSpec("spark", os.getenv("BUGCENSUS_SPARK_MODEL", "muse-spark-1.3"),
                           meta_base, "META_API_KEY"),
        "wonder": ModelSpec("wonder", os.getenv("BUGCENSUS_WONDER_MODEL", "muse-wonder-1.0"),
                            meta_base, "META_API_KEY"),
        "spark_open": ModelSpec("spark_open",
                                os.getenv("BUGCENSUS_SPARK_OPEN_MODEL", "meta-models/muse-spark-open-1026"),
                                baseten_base, "BASETEN_API_KEY", open_weights=True),
    }


def panel_names() -> list[str]:
    raw = os.getenv("BUGCENSUS_PANEL", "spark,glimmer")
    return [p.strip() for p in raw.split(",") if p.strip()]


def reasoning_effort() -> str | None:
    value = os.getenv("BUGCENSUS_REASONING_EFFORT", "low").strip()
    return value or None


def local_max_tokens() -> int:
    """Generation budget for locally served models; their reasoning is long and servers default low."""
    return int(os.getenv("BUGCENSUS_LOCAL_MAX_TOKENS", "6000"))
