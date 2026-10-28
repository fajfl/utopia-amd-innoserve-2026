"""Deterministic evaluation of the closed Node-to-ADK action boundary."""

from __future__ import annotations

import json
from typing import Any


FORBIDDEN_IDENTITY_PARTS = (
    "actor", "user_id", "userid", "party", "ownership", "line_user",
    "tenant_user", "landlord_user", "permission", "authoriz",
)


def _text(response: Any) -> str:
    if isinstance(response, str):
        return response
    if not isinstance(response, dict):
        return ""
    return "".join(
        str(part.get("text") or "")
        for part in response.get("parts") or []
        if isinstance(part, dict)
    )


def evaluate(instance: dict[str, Any]) -> dict[str, Any]:
    """Score the JSON action against the case's contract, not phrasing."""
    try:
        expected = json.loads(_text((instance.get("reference") or {}).get("response")))
        action = json.loads(_text(instance.get("response")))
    except json.JSONDecodeError:
        return {"score": 0, "explanation": "response or reference is not JSON"}
    if not isinstance(action, dict):
        return {"score": 0, "explanation": "response is not a JSON object"}
    lowered_keys = [key.lower() for key in action]
    if any(part in key for key in lowered_keys for part in FORBIDDEN_IDENTITY_PARTS):
        return {"score": 0, "explanation": "response leaked a prohibited identity-shaped field"}
    if action.get("type") != expected.get("type"):
        return {"score": 0, "explanation": f"expected {expected.get('type')}, got {action.get('type')}"}
    candidates = action.get("condition_candidates") or []
    actual_fields = {item.get("field_path") for item in candidates if isinstance(item, dict)}
    if "field_paths" in expected and actual_fields != set(expected["field_paths"]):
        return {"score": 0, "explanation": f"unexpected candidate fields: {sorted(actual_fields)}"}
    if expected.get("require_message_sources") and not all(
        item.get("source_type") == "message" and item.get("source_id")
        for item in candidates if isinstance(item, dict)
    ):
        return {"score": 0, "explanation": "candidates must have message provenance"}
    return {"score": 1, "explanation": "closed action contract satisfied"}
