"""Contract tests for the Node <-> ADK boundary.

Stdlib only, so this runs with `python -m unittest discover tests` on a bare
interpreter — no venv, no Vertex project, no ADC token, no network. The point of
these tests is exactly the part that must hold when the model misbehaves.

    cd agent_runtime/ecs-neo-agent
    python -m unittest discover -s tests -t .
"""
from __future__ import annotations

import importlib.util
import json
import os
import unittest

# Loaded by path on purpose. `app/__init__.py` imports the ADK agent, which pulls
# in google.adk and a Vertex-shaped environment; this module must stay testable
# without either, so importing `app.proposed_action` normally would defeat it.
_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app",
    "proposed_action.py",
)
_spec = importlib.util.spec_from_file_location("ecs_neo_proposed_action", _MODULE_PATH)
proposed_action = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(proposed_action)

ACTION_TYPES = proposed_action.ACTION_TYPES
InvalidModelOutput = proposed_action.InvalidModelOutput
authorize = proposed_action.authorize
build_turn_prompt = proposed_action.build_turn_prompt
parse_proposed_action = proposed_action.parse_proposed_action

SECRET = "a-long-random-shared-secret"


def action(**overrides):
    payload = {"type": "answer", "response_text": "租金是兩萬。"}
    payload.update(overrides)
    return json.dumps(payload, ensure_ascii=False)


class AuthorizeTest(unittest.TestCase):
    def test_accepts_matching_bearer(self):
        self.assertTrue(authorize(f"Bearer {SECRET}", SECRET))

    def test_rejects_wrong_secret(self):
        self.assertFalse(authorize("Bearer nope", SECRET))

    def test_rejects_missing_header(self):
        self.assertFalse(authorize(None, SECRET))

    def test_rejects_non_bearer_scheme(self):
        self.assertFalse(authorize(f"Basic {SECRET}", SECRET))

    def test_unset_secret_never_authorizes(self):
        # A missing secret is a deployment error, not anonymous access.
        self.assertFalse(authorize("Bearer ", ""))
        self.assertFalse(authorize("Bearer anything", ""))


class ParseProposedActionTest(unittest.TestCase):
    def test_pending_items_boundary(self):
        items = [{"operation": "add", "source_id": "11"}]
        self.assertEqual(parse_proposed_action(action(pending_items=items))["pending_items"], items)
        for invalid in (
            [{"operation": "add", "source_id": "11", "actor": "landlord"}],
            [{"operation": "resolve", "source_id": "11", "item_id": "p", "resolution": "signed"}],
            items * 21,
        ):
            with self.assertRaises(InvalidModelOutput):
                parse_proposed_action(action(pending_items=invalid))

    def test_parses_every_action_type(self):
        for action_type in ACTION_TYPES:
            payload = {"type": action_type, "response_text": "好的。"}
            if action_type == "propose_tenant_confirmation":
                payload["condition_candidates"] = [
                    {
                        "field_path": "rent_amount",
                        "value": 20000,
                        "source_type": "message",
                        "source_id": "12",
                    }
                ]
            parsed = parse_proposed_action(json.dumps(payload, ensure_ascii=False))
            self.assertEqual(parsed["type"], action_type)

    def test_no_action_may_omit_text(self):
        parsed = parse_proposed_action(json.dumps({"type": "no_action"}))
        self.assertEqual(parsed["response_text"], "")

    def test_other_actions_require_text(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(json.dumps({"type": "answer"}))

    def test_rejects_unknown_action_type(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(action(type="sign_contract"))

    def test_rejects_action_outside_permitted_set(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(
                action(type="escalate_to_landlord"), permitted=["answer", "no_action"]
            )

    def test_rejects_unknown_top_level_field(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(action(contract_version_public_id="cv-1"))

    def test_rejects_identity_fields(self):
        for key in ("actor", "tenant_user_id", "party_role", "permissions"):
            with self.assertRaises(InvalidModelOutput, msg=key):
                parse_proposed_action(action(**{key: "anything"}))

    def test_rejects_non_json(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action("好的，租金是兩萬。")

    def test_rejects_empty_output(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action("")

    def test_accepts_fenced_json(self):
        parsed = parse_proposed_action("```json\n" + action() + "\n```")
        self.assertEqual(parsed["type"], "answer")

    def test_candidate_requires_source(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(
                action(
                    type="propose_tenant_confirmation",
                    condition_candidates=[
                        {"field_path": "rent_amount", "value": 20000,
                         "source_type": "message"}
                    ],
                )
            )

    def test_candidate_rejects_unknown_source_type(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(
                action(
                    type="propose_tenant_confirmation",
                    condition_candidates=[
                        {"field_path": "rent_amount", "value": 20000,
                         "source_type": "model_guess", "source_id": "1"}
                    ],
                )
            )

    def test_move_in_and_lease_start_remain_distinct_in_transport(self):
        candidates = [
            {"field_path": "lease_start_date", "value": "2026-10-01",
             "source_type": "message", "source_id": "12"},
            {"field_path": "move_in_date", "value": "2026-10-05",
             "source_type": "message", "source_id": "12"},
        ]
        parsed = parse_proposed_action(action(
            type="propose_tenant_confirmation", condition_candidates=candidates
        ))
        self.assertEqual(parsed["condition_candidates"], candidates)

    def test_confirmation_without_candidates_is_refused(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(action(type="propose_tenant_confirmation"))

    def test_rejects_unknown_decision_classification(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(action(decision_classification="probably_fine"))

    def test_rejects_overlong_text(self):
        with self.assertRaises(InvalidModelOutput):
            parse_proposed_action(action(response_text="安" * 2001))


class BuildTurnPromptTest(unittest.TestCase):
    def turn(self, **context):
        base = {
            "event": {"text": "租金可以少一點嗎"},
            "inquiry": {"public_id": "inq-1"},
            "context": {
                "listing": {"title": "松山套房", "status": "active",
                            "currentRentAmount": 20000, "currentDepositAmount": 40000},
                "negotiationAuthority": {"verdict": "below_floor", "hasPolicy": True,
                                         "mustEscalate": True},
                "competition": {"otherActiveIntentionCount": 1, "unitClaimed": False},
                "authorizedKnowledge": {"knowledge": []},
                "intention": None,
                "conversationWindow": [{"role": "tenant", "text": "你好"}],
            },
        }
        base["context"].update(context)
        return base

    def test_prompt_carries_the_authority_verdict_but_no_amount(self):
        prompt = build_turn_prompt(self.turn())
        self.assertIn("below_floor", prompt)
        self.assertIn("escalate_to_landlord", prompt)

    def test_prompt_never_contains_a_floor_price(self):
        # The Node context builder refuses to put an amount in; this asserts the
        # prompt renderer does not reintroduce one from anywhere else.
        prompt = build_turn_prompt(self.turn())
        self.assertNotIn("16000", prompt)
        self.assertNotIn("floorRentAmount", prompt)

    def test_prompt_states_the_competition_count_only(self):
        prompt = build_turn_prompt(self.turn())
        self.assertIn("otherActiveIntentionCount=1", prompt)
        self.assertNotIn("另一位房客", prompt)

    def test_prompt_carries_the_node_side_flow_verdict(self):
        # Without this the model has to guess what happens next, and the order
        # here is a product decision (the landlord confirms the terms before any
        # signing starts), not something general knowledge gets right.
        prompt = build_turn_prompt(self.turn(caseStatus={
            "nextStep": "awaiting_landlord_terms",
            "nextStepNote": "草稿已建立，等房東確認條件才能開始簽署",
            "tenantConfirmedVersion": True,
            "draftReady": True,
            "landlordConfirmedTerms": False,
            "tenantSigned": False,
            "landlordDecision": None,
        }))
        self.assertIn("nextStep=awaiting_landlord_terms", prompt)
        self.assertIn("等房東確認條件", prompt)
        self.assertIn("房東已確認條件=False", prompt)
        self.assertIn("房東最後決定=（尚無）", prompt)

    def test_prompt_carries_the_landlord_reason_verbatim(self):
        prompt = build_turn_prompt(self.turn(caseStatus={
            "nextStep": "rejected",
            "nextStepNote": "房東拒絕了這一筆意向，房客可以在原地重新協調",
            "landlordDecision": {"decision": "rejected", "reason": "這間我打算自己住"},
        }))
        self.assertIn("房東最後決定=rejected", prompt)
        self.assertIn("這間我打算自己住", prompt)

    def test_prompt_survives_a_context_without_flow_state(self):
        # Older Node builds send no caseStatus. Render "未知" rather than crash.
        prompt = build_turn_prompt(self.turn())
        self.assertIn("nextStep=未知", prompt)

    def test_prompt_lists_the_permitted_actions(self):
        turn = self.turn()
        turn["permitted_action_names"] = ["answer", "no_action"]
        prompt = build_turn_prompt(turn)
        self.assertIn("answer, no_action", prompt)

    def test_prompt_preserves_message_source_ids_for_grounded_candidates(self):
        prompt = build_turn_prompt(
            self.turn(conversationWindow=[
                {"role": "tenant", "text": "租金兩萬", "sourceId": "91"}
            ])
        )
        self.assertIn('"sourceId": "91"', prompt)


if __name__ == "__main__":
    unittest.main()
