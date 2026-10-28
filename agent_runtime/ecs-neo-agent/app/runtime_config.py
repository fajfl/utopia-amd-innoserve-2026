"""Load local runtime configuration without duplicating secrets into the sidecar."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv


AGENT_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = AGENT_DIR.parents[1]


def configure_runtime_environment() -> None:
    """Bridge the Node app's Vertex names to google-genai's standard names."""
    load_dotenv(AGENT_DIR / ".env")
    load_dotenv(PROJECT_DIR / ".env")

    if os.environ.get("VERTEX_PROJECT"):
        os.environ.setdefault("GOOGLE_CLOUD_PROJECT", os.environ["VERTEX_PROJECT"])
    if os.environ.get("VERTEX_LOCATION"):
        os.environ.setdefault("GOOGLE_CLOUD_LOCATION", os.environ["VERTEX_LOCATION"])
    if os.environ.get("GOOGLE_CLOUD_PROJECT"):
        os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")


def coordinator_model_options(env=None) -> dict:
    """Keep self-hosted credentials isolated from cloud provider keys."""
    env = os.environ if env is None else env
    provider = env.get("AI_PROVIDER", "deepseek").strip().lower()
    self_hosted = provider in ("vllm", "llamacpp")
    if self_hosted:
        values = {name: env.get(name, "").strip() for name in ("AI_MODEL", "AI_BASE_URL", "AI_API_KEY")}
        for name, value in values.items():
            if not value:
                raise RuntimeError(f"{name} is required for the self-hosted coordinator")
        model, base, key = values["AI_MODEL"], values["AI_BASE_URL"], values["AI_API_KEY"]
    else:
        model, base = "deepseek-flash", "https://api.deepseek.com"
        key = (env.get("DEEPSEEK_API_KEY") or env.get("deepseek_api") or "").strip()
        if not key:
            raise RuntimeError("DEEPSEEK_API_KEY is required for the coordinator")
    options = dict(
        model=f"openai/{model}", api_base=base.rstrip("/"), api_key=key,
        response_format={"type": "json_object"}, max_tokens=2048,
        timeout=18, num_retries=0,
    )
    if not self_hosted:
        options["extra_body"] = {"thinking": {"type": "disabled"}}
    return options
