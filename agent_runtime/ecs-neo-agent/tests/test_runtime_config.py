import os

from app.runtime_config import configure_runtime_environment


def test_node_vertex_names_enable_vertex_without_overwriting_google_names(monkeypatch):
    monkeypatch.setenv("VERTEX_PROJECT", "node-project")
    monkeypatch.setenv("VERTEX_LOCATION", "global")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT", raising=False)
    monkeypatch.delenv("GOOGLE_CLOUD_LOCATION", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)

    configure_runtime_environment()

    assert os.environ["GOOGLE_CLOUD_PROJECT"] == "node-project"
    assert os.environ["GOOGLE_CLOUD_LOCATION"] == "global"
    assert os.environ["GOOGLE_GENAI_USE_VERTEXAI"] == "true"


def test_explicit_google_configuration_wins_over_node_aliases(monkeypatch):
    monkeypatch.setenv("VERTEX_PROJECT", "node-project")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "sidecar-project")

    configure_runtime_environment()

    assert os.environ["GOOGLE_CLOUD_PROJECT"] == "sidecar-project"


def test_agent_instruction_limits_candidates_to_node_contract_fields():
    from app.agent import INSTRUCTION

    for field_name in (
        "rent_amount",
        "deposit_amount",
        "lease_start_date",
        "lease_end_date",
    ):
        assert field_name in INSTRUCTION
