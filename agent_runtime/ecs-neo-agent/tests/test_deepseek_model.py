"""Verify the real ADK connector contract without a provider call."""
from unittest.mock import AsyncMock, patch

import pytest
from google.adk.models.llm_request import LlmRequest
from google.adk.models.lite_llm import LiteLlm
from google.genai import types
from litellm import ModelResponse

from app.agent import MODEL, root_agent
from app.runtime_config import coordinator_model_options


@pytest.mark.asyncio
async def test_coordinator_uses_deepseek_json_without_google_auth():
    model = root_agent.model
    response = ModelResponse(
        model=MODEL,
        choices=[{"message": {"role": "assistant", "content": '{"type":"no_action"}'}, "finish_reason": "stop"}],
    )
    completion = AsyncMock(return_value=response)
    with patch.object(type(model.llm_client), "acompletion", completion):
        replies = [reply async for reply in model.generate_content_async(
            LlmRequest(
                model=model.model,
                contents=[types.Content(role="user", parts=[types.Part.from_text(text="Return JSON")])],
                config=root_agent.generate_content_config,
            )
        )]
    args = completion.call_args.kwargs
    assert args["model"] == "openai/deepseek-flash"
    assert args["api_base"] == "https://api.deepseek.com"
    assert args["response_format"] == {"type": "json_object"}
    assert args["extra_body"] == {"thinking": {"type": "disabled"}}
    assert args["max_tokens"] == 2048
    assert args["num_retries"] == 0
    assert args["timeout"] == 18
    assert replies[0].content.parts[0].text == '{"type":"no_action"}'


def test_coordinator_never_borrows_another_provider_key(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("deepseek_api", raising=False)
    monkeypatch.setenv("OPENAI_API_KEY", "unrelated-key")
    monkeypatch.setenv("GEMINI_API_KEY", "unrelated-key")
    with pytest.raises(RuntimeError, match="DEEPSEEK_API_KEY"):
        coordinator_model_options()


@pytest.mark.parametrize("provider", ["vllm", "llamacpp"])
def test_self_hosted_options_use_only_explicit_model_endpoint_and_key(provider):
    env = {"AI_PROVIDER": provider, "AI_MODEL": "ecsneo-model", "AI_BASE_URL": "http://127.0.0.1:8001/v1/", "AI_API_KEY": "self-hosted-test", "DEEPSEEK_API_KEY": "wrong-key"}
    options = coordinator_model_options(env)
    assert options["model"] == "openai/ecsneo-model"
    assert options["api_base"] == "http://127.0.0.1:8001/v1"
    assert options["api_key"] == "self-hosted-test"
    assert "extra_body" not in options
    for name in ("AI_MODEL", "AI_BASE_URL", "AI_API_KEY"):
        missing = {key: value for key, value in env.items() if key != name}
        with pytest.raises(RuntimeError, match=name):
            coordinator_model_options(missing)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["vllm", "llamacpp"])
async def test_self_hosted_adk_connector_sends_explicit_settings_without_thinking(provider):
    model = LiteLlm(**coordinator_model_options({
        "AI_PROVIDER": provider, "AI_MODEL": "ecsneo-model",
        "AI_BASE_URL": "http://127.0.0.1:8001/v1/", "AI_API_KEY": "local-key",
        "DEEPSEEK_API_KEY": "wrong-key",
    }))
    response = ModelResponse(model="ecsneo-model", choices=[{
        "message": {"role": "assistant", "content": '{"type":"no_action"}'},
        "finish_reason": "stop",
    }])
    completion = AsyncMock(return_value=response)
    with patch.object(type(model.llm_client), "acompletion", completion):
        replies = [reply async for reply in model.generate_content_async(LlmRequest(
            model=model.model,
            contents=[types.Content(role="user", parts=[types.Part.from_text(text="Return JSON")])],
            config=types.GenerateContentConfig(),
        ))]
    args = completion.call_args.kwargs
    assert args["model"] == "openai/ecsneo-model"
    assert args["api_base"] == "http://127.0.0.1:8001/v1"
    assert args["api_key"] == "local-key"
    assert args["response_format"] == {"type": "json_object"}
    assert "extra_body" not in args
    assert args["timeout"] == 18
    assert args["num_retries"] == 0
    assert replies[0].content.parts[0].text == '{"type":"no_action"}'
