"""Private HTTP boundary between the Node gateway and the ADK coordinator.

`/v1/turns:handle` really runs the ADK `Runner` against DeepSeek `deepseek-flash`
with thinking disabled and parses the model's final response into the
closed `proposed_action` set. There is **no** canned fallback action: a turn that
cannot be produced or parsed returns an error status so Node records
`model_provider_error` / `invalid_model_output` and tells the tenant the truth.
A sidecar that always answers "please clarify" looks healthy while the agent is
dead, and nobody finds out until a tenant complains.

The ADK dev UI is off (`web=False`) and CORS is closed. This service is meant to
be bound to loopback; Node refuses to call it in public demo mode regardless.
"""
import contextlib
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from a2a.server.tasks import InMemoryTaskStore
from fastapi import FastAPI, Header, HTTPException
from google.adk.cli.fast_api import get_fast_api_app
from google.adk.runners import Runner
from google.genai import types

from app.app_utils import services
from app.app_utils.a2a import attach_a2a_routes
from app.proposed_action import (
    InvalidModelOutput,
    authorize,
    build_turn_prompt,
    parse_proposed_action,
)
from app.runtime_config import configure_runtime_environment

configure_runtime_environment()
AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOG = logging.getLogger("ecs-neo-agent")


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    from app.agent import app as adk_app
    from app.agent import root_agent

    runner = Runner(
        agent=root_agent,
        app_name=adk_app.name,
        session_service=services.get_session_service(),
        artifact_service=services.get_artifact_service(),
    )
    app.state.runner = runner
    app.state.agent_app_name = adk_app.name
    await attach_a2a_routes(
        app,
        agent=root_agent,
        runner=runner,
        task_store=InMemoryTaskStore(),
        rpc_path=f"/a2a/{adk_app.name}",
    )
    yield


app: FastAPI = get_fast_api_app(
    agents_dir=AGENT_DIR,
    # The dev UI would expose the agent to anything that can reach the port.
    web=False,
    artifact_service_uri=services.ARTIFACT_SERVICE_URI,
    allow_origins=None,
    session_service_uri=services.SESSION_SERVICE_URI,
    otel_to_cloud=False,
    lifespan=lifespan,
)
app.title = "ecs-neo-agent"


async def _run_coordinator(runner: Runner, turn: dict[str, Any]) -> str:
    """Drive one ADK turn and return the model's final text."""
    # One ADK session per Node execution. Sessions are not the system of record —
    # Node's agent_executions is — so an ephemeral session per turn keeps the
    # sidecar stateless and prevents one tenant's turn from seeing another's.
    session_id = str(turn.get("execution_public_id") or turn.get("provider_event_public_id") or "turn")
    user_id = f"inquiry:{(turn.get('inquiry') or {}).get('public_id') or 'unknown'}"

    # 每次 webhook event 固定對應同一 session，重送時先取回而不是建立第二個。
    # Session 僅保存 ADK 執行上下文；Node 的 agent_executions 才是 system of record。
    session_service = runner.session_service
    session = await session_service.get_session(
        app_name=runner.app_name, user_id=user_id, session_id=session_id
    )
    if session is None:
        await session_service.create_session(
            app_name=runner.app_name, user_id=user_id, session_id=session_id
        )

    message = types.Content(
        role="user", parts=[types.Part.from_text(text=build_turn_prompt(turn))]
    )

    final_text = ""
    async for event in runner.run_async(
        user_id=user_id, session_id=session_id, new_message=message
    ):
        if event.is_final_response() and event.content and event.content.parts:
            final_text = "".join(
                part.text for part in event.content.parts if getattr(part, "text", None)
            )
    return final_text


@app.post("/v1/turns:handle")
async def handle_turn(
    turn: dict[str, Any], authorization: str | None = Header(default=None)
) -> dict[str, Any]:
    if not authorize(authorization, os.getenv("AGENT_RUNTIME_SHARED_SECRET", "")):
        raise HTTPException(status_code=401, detail="unauthorized")

    runner = getattr(app.state, "runner", None)
    if runner is None:  # pragma: no cover - only before lifespan startup
        raise HTTPException(status_code=503, detail="runner not ready")

    # 模型偶爾吐出不合 schema 的 JSON。房客只看到「暫時無法處理」，所以換一個全新的
    # ADK session 再問一次(不帶著那次錯誤的回答);第二次還不合格才回 422。
    attempts = [turn, {**turn, "execution_public_id": f"{turn.get('execution_public_id') or 'turn'}:retry"}]
    for attempt, current in enumerate(attempts):
        try:
            final_text = await _run_coordinator(runner, current)
        except Exception as error:
            # Never turn a provider fault into an invented answer. 502 lets Node
            # classify it as model_provider_error and keep the turn retryable.
            LOG.exception("ADK turn failed")
            raise HTTPException(status_code=502, detail=f"agent runtime error: {type(error).__name__}") from error

        try:
            return parse_proposed_action(final_text, turn.get("permitted_action_names"))
        except InvalidModelOutput as error:
            # 422 is distinguishable from 502 in the sidecar logs; Node treats any
            # non-2xx the same way — no side effects, nothing persisted.
            LOG.warning("rejected model output (attempt %d): %s", attempt + 1, error)
            if attempt == len(attempts) - 1:
                raise HTTPException(status_code=422, detail=str(error)) from error


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    """Liveness only. Deliberately unauthenticated and deliberately says nothing
    about credentials, project, or model entitlement."""
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.getenv("AGENT_RUNTIME_HOST", "127.0.0.1"),
        port=int(os.getenv("AGENT_RUNTIME_PORT", "8000")),
    )
