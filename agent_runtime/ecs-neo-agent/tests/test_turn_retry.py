"""模型第一次吐出不合 schema 的 JSON 時，換新 session 重問一次。"""
import asyncio
import json
import os
import unittest

os.environ.setdefault("AGENT_RUNTIME_SHARED_SECRET", "retry-test-secret-0123456789abcdef")
os.environ.setdefault("DEEPSEEK_API_KEY", "unused-in-this-test")

from app import fast_api_app  # noqa: E402

GOOD = json.dumps({
    "type": "no_action", "response_text": "", "grounding_refs": [], "condition_candidates": [],
    "conflicts": [], "missing_fields": [], "decision_classification": "grounded_and_authorized",
})


class TurnRetryTest(unittest.TestCase):
    def test_retries_once_with_a_fresh_session(self):
        outputs, sessions = ["{not json", GOOD], []

        async def fake_run(runner, turn):
            sessions.append(turn["execution_public_id"])
            return outputs.pop(0)

        original = fast_api_app._run_coordinator
        fast_api_app._run_coordinator = fake_run
        fast_api_app.app.state.runner = object()
        try:
            result = asyncio.run(fast_api_app.handle_turn(
                {"execution_public_id": "exec-1", "permitted_action_names": ["no_action"]},
                authorization="Bearer " + os.environ["AGENT_RUNTIME_SHARED_SECRET"],
            ))
        finally:
            fast_api_app._run_coordinator = original
        self.assertEqual(result["type"], "no_action")
        self.assertEqual(sessions, ["exec-1", "exec-1:retry"])

    def test_reasoning_parts_are_not_part_of_the_answer(self):
        from types import SimpleNamespace as NS

        class Sessions:
            async def get_session(self, **_):
                return object()

        class Runner:
            app_name, session_service = 'test', Sessions()

            async def run_async(self, **_):
                parts = [NS(text='We need to think', thought=True), NS(text=GOOD, thought=False)]
                yield NS(is_final_response=lambda: True, content=NS(parts=parts))

        self.assertEqual(asyncio.run(fast_api_app._run_coordinator(Runner(), {})), GOOD)


if __name__ == "__main__":
    unittest.main()
