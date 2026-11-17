"""The model chain must never regress to the discontinued names or lose its request shape."""
from regulatory_ingestion.agent import llm as L


def test_chain_uses_live_model_names():
    names = [s.model for s in L.CHAIN]
    assert "deepseek-reasoner" not in names and "deepseek-chat" not in names
    assert names[0] == "deepseek-v4-flash"


def test_thinking_rung_shape():
    head = L.CHAIN[0]
    assert head.reasoning and head.thinking is True and head.structured == "json_mode"
    assert head.extra_body()["thinking"]["type"] == "enabled"
    second = L.CHAIN[1]
    assert second.thinking is False and second.extra_body()["thinking"]["type"] == "disabled"
