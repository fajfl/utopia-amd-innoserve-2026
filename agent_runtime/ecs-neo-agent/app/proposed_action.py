"""Turn envelope and proposed action — the typed boundary between Node and ADK.

This module imports **nothing** outside the standard library. Not pydantic, not
google.adk, not google.genai. Two reasons:

1. The schema is the contract with Node. It has to be checkable without a Vertex
   project, an ADC token, a network, or even the project's virtualenv, so
   ``tests/test_proposed_action.py`` runs on a bare interpreter.
2. Everything that decides *what Node is allowed to act on* lives here, in one
   file, with no framework in the way.

The action set is closed and matches ``.agents-cli-spec.md`` and the Node side's
``ecsNeoAgentRuntimeClient.PROPOSED_ACTION_TYPES`` exactly. Adding a member here
without adding it there means Node rejects the turn as ``invalid_model_output``.
"""
from __future__ import annotations

import json
import re
import secrets
from typing import Any

ACTION_TYPES = (
    "answer",
    "ask_clarification",
    "escalate_to_landlord",
    "show_condition_summary",
    "propose_tenant_confirmation",
    "propose_landlord_decision",
    "explain_status_or_change",
    "no_action",
)

DECISION_CLASSIFICATIONS = (
    "grounded_and_authorized",
    "needs_clarification",
    "needs_landlord",
    "system_failure",
)

CANDIDATE_SOURCE_TYPES = (
    "message",
    "listing_snapshot",
    "knowledge_version",
    "manual_input",
)

ALLOWED_TOP_LEVEL_KEYS = frozenset(
    {
        "type",
        "response_text",
        "grounding_refs",
        "condition_candidates",
        "pending_items",
        "conflicts",
        "missing_fields",
        "decision_classification",
    }
)

RESPONSE_TEXT_MAX_LENGTH = 2000

# The model must never assert who anybody is. Node derives identity from the
# persisted channel event; anything identity-shaped coming back from the model is
# a rejected turn, not a value to be merged.
IDENTITY_KEY_PATTERN = re.compile(
    r"(actor|user_id|userid|party|ownership|line_user|tenant_user|landlord_user"
    r"|permission|authoriz)",
    re.IGNORECASE,
)


class InvalidModelOutput(ValueError):
    """The model returned something the gateway must refuse. No side effects."""


def authorize(authorization_header: str | None, expected_secret: str) -> bool:
    """Bearer check, fail closed.

    An unset secret is a deployment error, not permission to run anonymously —
    it returns False so the sidecar refuses every request until it is configured.
    """
    if not expected_secret or not authorization_header:
        return False
    if not authorization_header.startswith("Bearer "):
        return False
    return secrets.compare_digest(
        authorization_header[len("Bearer ") :], expected_secret
    )


def _require_str_list(value: Any, name: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise InvalidModelOutput(f"{name} must be a list")
    out = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise InvalidModelOutput(f"{name} entries must be non-empty strings")
        out.append(item.strip()[:200])
    return out


def _require_candidates(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise InvalidModelOutput("condition_candidates must be a list")
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise InvalidModelOutput("condition_candidates entries must be objects")
        for key in item:
            if IDENTITY_KEY_PATTERN.search(key):
                raise InvalidModelOutput(
                    f"condition_candidates must not carry identity field {key}"
                )
        field_path = item.get("field_path")
        if not isinstance(field_path, str) or not field_path.strip():
            raise InvalidModelOutput("condition_candidates entry needs field_path")
        source_type = item.get("source_type")
        if source_type not in CANDIDATE_SOURCE_TYPES:
            raise InvalidModelOutput(
                f"{field_path} has unknown source_type {source_type!r}"
            )
        source_id = item.get("source_id")
        # "The model thought so" is not a source, so this is required.
        if source_id in (None, ""):
            raise InvalidModelOutput(f"{field_path} is missing source_id")
        out.append(
            {
                "field_path": field_path.strip(),
                "value": item.get("value"),
                "source_type": source_type,
                "source_id": str(source_id),
            }
        )
    return out


def _require_conflicts(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise InvalidModelOutput("conflicts must be a list")
    out = []
    for item in value:
        if not isinstance(item, dict):
            raise InvalidModelOutput("conflicts entries must be objects")
        field_path = item.get("field_path")
        if not isinstance(field_path, str) or not field_path.strip():
            raise InvalidModelOutput("conflicts entry needs field_path")
        note = item.get("note")
        out.append(
            {
                "field_path": field_path.strip(),
                "note": note.strip()[:500] if isinstance(note, str) else None,
            }
        )
    return out


def _require_pending_items(value: Any) -> list[dict[str, Any]]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > 20:
        raise InvalidModelOutput("pending_items must be a list of at most 20 entries")
    for item in value:
        if (not isinstance(item, dict)
                or set(item) - {"operation", "source_id", "item_id", "resolution", "quote", "field_path"}
                or item.get("operation") not in ("add", "resolve")
                or not isinstance(item.get("source_id"), (str, int))
                or not re.fullmatch(r"[1-9][0-9]{0,19}", str(item.get("source_id")))):
            raise InvalidModelOutput("invalid pending_items entry")
        if "quote" in item and (not isinstance(item["quote"], str) or not item["quote"].strip() or len(item["quote"]) > 1000):
            raise InvalidModelOutput("pending_items quote must be 1 to 1000 characters")
        if "field_path" in item and (not isinstance(item["field_path"], str) or len(item["field_path"]) > 64):
            raise InvalidModelOutput("invalid pending_items field_path")
        if item["operation"] == "resolve" and (
                not isinstance(item.get("item_id"), str)
                or not re.fullmatch(r"pending-[0-9a-f-]{36}", item.get("item_id"))
                or item.get("resolution") not in ("included", "withdrawn")):
            raise InvalidModelOutput("pending_items resolution needs item_id and resolution")
    return value


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return stripped
    body = stripped.split("\n", 1)[1] if "\n" in stripped else ""
    if body.rstrip().endswith("```"):
        body = body.rstrip()[: -len("```")]
    return body.strip()


def parse_proposed_action(
    raw_text: str, permitted: "tuple[str, ...] | list[str] | None" = None
) -> dict[str, Any]:
    """Turn the model's final response into a proposed action, or refuse it.

    There is deliberately **no** "best effort" path here and no default action.
    A sidecar that quietly answers ``ask_clarification`` whenever parsing fails
    looks healthy while the real agent is dead, and Node cannot tell the two
    apart. Refusing lets Node record ``invalid_model_output`` and tell the tenant
    the truth instead of inventing an answer.
    """
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise InvalidModelOutput("model returned no text")

    try:
        payload = json.loads(_strip_code_fence(raw_text))
    except json.JSONDecodeError as error:
        raise InvalidModelOutput(f"model output is not JSON: {error}") from error

    if not isinstance(payload, dict):
        raise InvalidModelOutput("model output is not an object")

    for key in payload:
        if IDENTITY_KEY_PATTERN.search(key):
            raise InvalidModelOutput(
                f"model output must not carry identity field {key}"
            )
        if key not in ALLOWED_TOP_LEVEL_KEYS:
            raise InvalidModelOutput(f"model output has unknown field {key}")

    action_type = payload.get("type")
    allowed = tuple(permitted) if permitted else ACTION_TYPES
    if action_type not in ACTION_TYPES:
        raise InvalidModelOutput(f"unknown proposed action type {action_type!r}")
    if action_type not in allowed:
        raise InvalidModelOutput(f"action {action_type} is not permitted for this turn")

    response_text = payload.get("response_text")
    if response_text is None:
        response_text = ""
    if not isinstance(response_text, str):
        raise InvalidModelOutput("response_text must be a string")
    response_text = response_text.strip()
    if action_type != "no_action" and not response_text:
        raise InvalidModelOutput("response_text is required")
    if len(response_text) > RESPONSE_TEXT_MAX_LENGTH:
        raise InvalidModelOutput("response_text is too long")

    classification = payload.get("decision_classification")
    if classification is not None and classification not in DECISION_CLASSIFICATIONS:
        raise InvalidModelOutput(
            f"unknown decision_classification {classification!r}"
        )

    candidates = _require_candidates(payload.get("condition_candidates"))
    if action_type == "propose_tenant_confirmation" and not candidates:
        # Asking the tenant to confirm nothing is not a real proposal, and Node
        # would reject the empty version anyway. Fail here where it is visible.
        raise InvalidModelOutput(
            "propose_tenant_confirmation requires condition_candidates"
        )

    return {
        "type": action_type,
        "response_text": response_text,
        "grounding_refs": _require_str_list(
            payload.get("grounding_refs"), "grounding_refs"
        ),
        "condition_candidates": candidates,
        "pending_items": _require_pending_items(payload.get("pending_items")),
        "conflicts": _require_conflicts(payload.get("conflicts")),
        "missing_fields": _require_str_list(
            payload.get("missing_fields"), "missing_fields"
        ),
        "decision_classification": classification,
    }


def build_turn_prompt(turn: dict[str, Any]) -> str:
    """Render the envelope into the single user message for this turn.

    The context was assembled and privacy-checked on the Node side
    (``ecsNeoAgentContextService``). This function must not add facts, look
    anything up, or reorder authority — it only formats.
    """
    context = turn.get("context") or {}
    listing = context.get("listing") or {}
    authority = context.get("negotiationAuthority") or {}
    competition = context.get("competition") or {}
    case_status = context.get("caseStatus") or {}
    decision = case_status.get("landlordDecision") or {}
    permitted = turn.get("permitted_action_names") or list(ACTION_TYPES)

    return "\n".join(
        [
            "以下是這一輪的授權脈絡。除了這裡列出的內容，你沒有其他資料來源。",
            "",
            f"房源：{listing.get('title') or '（未提供）'}（狀態 {listing.get('status') or '未知'}）",
            f"公開租金：{listing.get('currentRentAmount')}　公開押金：{listing.get('currentDepositAmount')}",
            "",
            "議價授權判定（Node 端依房東規則算出的結論；你拿不到也不需要知道任何底價金額）：",
            "  verdict={} hasPolicy={} mustEscalate={}".format(
                authority.get("verdict"),
                authority.get("hasPolicy"),
                authority.get("mustEscalate"),
            ),
            "  verdict=below_floor 或 mustEscalate=true 時必須 escalate_to_landlord，不得自行答應降租。",
            "",
            "同房源競爭狀況（只有計數；不得推測、詢問或透露其他房客是誰）：",
            "  otherActiveIntentionCount={} unitClaimed={}".format(
                competition.get("otherActiveIntentionCount"),
                competition.get("unitClaimed"),
            ),
            "",
            "授權知識庫：",
            json.dumps(context.get("authorizedKnowledge") or {}, ensure_ascii=False),
            "",
            # 這一段是 Node 算出來的流程判定。沒有它，模型被問到「接下來呢」只能
            # 用一般常識猜，而這條線的順序是產品自己定的（房東要先確認條件才開始
            # 簽署、拒絕之後對話留著）。這裡只轉述，不重新推理。
            "流程狀態（Node 判定；說明進度時只能照這裡說，不得自行推測順序）：",
            "  nextStep={} 說明：{}".format(
                case_status.get("nextStep") or "未知",
                case_status.get("nextStepNote") or "（未提供）",
            ),
            "  房客已確認版本={} 草稿已建立={} 房東已確認條件={} 房客已簽名={}".format(
                case_status.get("tenantConfirmedVersion"),
                case_status.get("draftReady"),
                case_status.get("landlordConfirmedTerms"),
                case_status.get("tenantSigned"),
            ),
            "  房東最後決定={} 房東寫的理由={}".format(
                decision.get("decision") or "（尚無）",
                decision.get("reason") or "（沒有寫）",
            ),
            "  草稿還缺的法定條款：{}".format(
                "、".join(case_status.get("missingClauses") or []) or "（無）"
            ),
            "",
            # 房客自己留的點交紀錄。沒有這段，模型被問到裂痕只能說「看不到」。
            "入住前點交紀錄（房客自己記的；null 代表還沒有）：",
            json.dumps(context.get("conditionRecord"), ensure_ascii=False),
            "",
            "目前的承租意向與各個精確版本（沒有「最新版」欄位；指名版本一律用 publicId）：",
            json.dumps(context.get("intention"), ensure_ascii=False),
            "待確認事項（原話不是契約條件；未結案事項每輪保留）：",
            json.dumps(context.get("pendingItems") or [], ensure_ascii=False),
            "",
            # role=agent 是**你自己**上一輪講的話。沒有標清楚的話,模型會把自己
            # 說過的內容當成別人說的,於是重複發問、重複承諾。
            "近期對話（role：tenant=房客、agent=你自己上一輪的回覆、landlord=房東直接傳給房客的訊息）：",
            json.dumps(context.get("conversationWindow") or [], ensure_ascii=False),
            "",
            f"這一則房客訊息：{(turn.get('event') or {}).get('text') or ''}",
            "",
            f"允許的 action：{', '.join(permitted)}",
            "只輸出一個 JSON 物件，不要有其他文字。",
        ]
    )
