"""The Claude API client, the provider settings, the stub and the budget arithmetic, against a
local stand-in for the Claude API (stub_claude_server.py) that the official SDK talks to
unchanged. No real key and no network. Synthetic data only."""

from __future__ import annotations

import json
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest

from app.modules.ai import budget, config
from app.modules.ai.claude_client import ClaudeClient, wire_schema
from app.modules.ai.model_client import ModelError, OpenAICompatibleClient
from app.modules.ai.schemas import NOTE_DRAFT_SCHEMA
from app.modules.ai.stub_model import NOTICE, StubModel, note_draft

from .stub_claude_server import StubClaudeServer

FAKE_KEY = "test-key-not-a-real-key"   # noqa: S105 (a placeholder the stand-in accepts)
MESSAGES = [{"role": "system", "content": "Draft the note.\nSections:\n- 61150-9: Subjective"},
            {"role": "user", "content": "Dictation:\nFollow-up for a cough; it has gone."}]


@pytest.fixture
def claude(monkeypatch: pytest.MonkeyPatch) -> Iterator[StubClaudeServer]:
    server = StubClaudeServer()
    server.start()
    monkeypatch.setenv("ANTHROPIC_BASE_URL", server.url)
    try:
        yield server
    finally:
        server.stop()


def _client(**kw: Any) -> ClaudeClient:
    values: dict[str, Any] = {"model": "claude-sonnet-5-5", "api_key": FAKE_KEY,
                              "max_retries": 0, "timeout": 5.0}
    return ClaudeClient(**(values | kw))


# ================================================================================ the client
async def test_one_messages_call_with_the_schema_and_its_usage(
        claude: StubClaudeServer) -> None:
    claude.reply = '{"sections": [{"code": "61150-9", "text": "Cough has gone."}]}'
    reply = await _client().complete(MESSAGES, max_tokens=2048, schema=NOTE_DRAFT_SCHEMA)
    assert json.loads(reply.content)["sections"][0]["text"] == "Cough has gone."
    assert (reply.model, reply.prompt_tokens, reply.completion_tokens) == (
        "claude-sonnet-5-5", 1200, 300)
    sent = claude.requests[0]
    assert sent["model"] == "claude-sonnet-5-5" and sent["max_tokens"] == 16000
    assert sent["system"].startswith("Draft the note.")
    assert sent["messages"] == [{"role": "user", "content": [
        {"type": "text", "text": MESSAGES[1]["content"]}]}]
    assert sent["output_config"]["effort"] == "low"
    fmt = sent["output_config"]["format"]
    assert fmt["type"] == "json_schema" and fmt["schema"]["additionalProperties"] is False
    assert "thinking" not in sent and "temperature" not in sent   # adaptive by default
    assert claude.keys == [FAKE_KEY]


def test_the_wire_schema_keeps_the_shape_and_drops_what_the_api_does_not_take() -> None:
    sent = wire_schema(NOTE_DRAFT_SCHEMA)
    assert "$schema" not in sent and "$id" not in sent and "title" not in sent
    section = sent["properties"]["sections"]["items"]
    assert section == {"type": "object", "additionalProperties": False,
                       "required": ["code", "text"],
                       "properties": {"code": {"type": "string"}, "text": {"type": "string"}}}
    assert "maxItems" not in sent["properties"]["sections"]
    assert "minLength" not in json.dumps(sent) and "pattern" not in json.dumps(sent)


async def test_a_refusal_is_declined_and_keeps_its_tokens(claude: StubClaudeServer) -> None:
    claude.refuse = True
    with pytest.raises(ModelError) as declined:
        await _client().complete(MESSAGES, max_tokens=2048)
    assert declined.value.kind == "declined" and "general_harms" in str(declined.value)
    assert (declined.value.prompt_tokens, declined.value.completion_tokens) == (1200, 300)


@pytest.mark.parametrize("status", [400, 401, 429, 500, 529])
async def test_http_errors_are_failures_without_a_body(claude: StubClaudeServer,
                                                       status: int) -> None:
    claude.fail_with = status
    with pytest.raises(ModelError) as failed:
        await _client().complete(MESSAGES, max_tokens=2048)
    assert failed.value.kind == "failed" and "unavailable" not in str(failed.value)
    assert failed.value.__cause__ is None and failed.value.__suppress_context__


async def test_an_unreachable_api_is_a_failure() -> None:
    client = _client(base_url="http://127.0.0.1:9")
    with pytest.raises(ModelError) as failed:
        await client.complete(MESSAGES, max_tokens=2048)
    assert failed.value.kind in ("failed", "timeout")


def test_the_key_never_shows_in_the_clients_repr() -> None:
    assert FAKE_KEY not in repr(_client())


# ============================================================================== the settings
@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in (config.PROVIDER_ENV, config.API_KEY_ENV, config.MODEL_URL_ENV,
                 config.MODEL_NAME_ENV, config.CLAUDE_MODEL_ENV, config.EFFORT_ENV,
                 config.ENVIRONMENT_ENV):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_with_a_key_the_provider_is_claude_on_sonnet(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv(config.API_KEY_ENV, FAKE_KEY)
    model = config.configured_model()
    assert isinstance(model, ClaudeClient)
    assert (model.model, model.effort) == ("claude-sonnet-5-5", "low")


def test_the_model_and_effort_are_settings(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv(config.API_KEY_ENV, FAKE_KEY)
    clean_env.setenv(config.CLAUDE_MODEL_ENV, "claude-haiku-5-5")
    clean_env.setenv(config.EFFORT_ENV, "medium")
    model = config.configured_model()
    assert isinstance(model, ClaudeClient)
    assert (model.model, model.effort) == ("claude-haiku-5-5", "medium")
    clean_env.setenv(config.EFFORT_ENV, "enormous")
    model = config.configured_model()
    assert isinstance(model, ClaudeClient) and model.effort == "low"


def test_claude_without_a_key_is_unconfigured(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv(config.PROVIDER_ENV, "claude")
    assert isinstance(config.configured_model(), config.UnconfiguredModel)


@pytest.mark.parametrize("environment", ["development", "test", "staging"])
def test_without_a_key_the_stub_answers_outside_production(
        clean_env: pytest.MonkeyPatch, environment: str) -> None:
    clean_env.setenv(config.ENVIRONMENT_ENV, environment)
    assert config.provider() == "stub"
    assert isinstance(config.configured_model(), StubModel)


@pytest.mark.parametrize("environment", ["production", ""])
def test_the_stub_never_answers_in_production(clean_env: pytest.MonkeyPatch,
                                              environment: str) -> None:
    """An unset ENVIRONMENT is production for core, so it is here too."""
    if environment:
        clean_env.setenv(config.ENVIRONMENT_ENV, environment)
    clean_env.setenv(config.PROVIDER_ENV, "stub")
    assert isinstance(config.configured_model(), config.UnconfiguredModel)


def test_a_model_server_url_still_picks_the_openai_compatible_client(
        clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv(config.MODEL_URL_ENV, "http://gpu-host:8000/v1")
    clean_env.setenv(config.MODEL_NAME_ENV, "qwen3.5-4b")
    assert isinstance(config.configured_model(), OpenAICompatibleClient)


def test_an_unknown_provider_is_unconfigured(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setenv(config.PROVIDER_ENV, "bedrock")
    assert isinstance(config.configured_model(), config.UnconfiguredModel)


# ================================================================================== the stub
async def test_the_stub_fills_the_templates_sections_and_says_it_is_a_sample() -> None:
    prompt = "Sections:\n- 61150-9: Subjective (required)\n- 61149-1: Objective (required)\n" \
             "- 11369-6: Preventive care: immunizations"
    reply = await StubModel().complete([{"role": "system", "content": prompt},
                                        {"role": "user", "content": "anything"}],
                                       max_tokens=2048)
    draft = json.loads(reply.content)
    assert [s["code"] for s in draft["sections"]] == ["61150-9", "61149-1", "11369-6"]
    assert draft["sections"][0]["text"].startswith(NOTICE)
    assert draft["sections"][2]["text"] == "Not discussed"
    assert reply.model == "stub" and reply.prompt_tokens is None


def test_the_stub_draft_for_no_sections_is_empty() -> None:
    assert note_draft("no sections listed") == {"sections": [], "unknowns": []}


# ================================================================================ the budget
def test_cost_at_list_price() -> None:
    assert budget.cost("claude-sonnet-5-5", 1_000_000, 100_000) == Decimal("3")
    assert budget.cost("claude-haiku-5-5", 2_000_000, 0) == Decimal("0.2")
    assert budget.cost("stub", 10**9, 10**9) == Decimal(0)
    assert budget.cost("qwen3.5-4b", 10**9, 10**9) == Decimal(0)


def test_the_estimate_sums_every_model() -> None:
    used = [budget.Usage("claude-sonnet-5-5", 10_000_000, 2_000_000),
            budget.Usage("claude-haiku-5-5", 10_000_000, 0),
            budget.Usage("stub", 99, 99)]
    assert budget.estimate(used) == Decimal("41")


def test_the_limit_is_140_unless_set(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(budget.LIMIT_ENV, raising=False)
    assert budget.limit() == Decimal("140")
    monkeypatch.setenv(budget.LIMIT_ENV, "25.5")
    assert budget.limit() == Decimal("25.5")
    for bad in ("lots", "-3"):
        monkeypatch.setenv(budget.LIMIT_ENV, bad)
        assert budget.limit() == Decimal("140")


async def test_the_sdk_never_logs_a_request_body(claude: StubClaudeServer,
                                                 caplog: pytest.LogCaptureFixture,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    """The SDK logs whole request bodies at DEBUG (and ANTHROPIC_LOG=debug asks for that):
    its loggers stay at WARNING, so with every logger at DEBUG nothing of the dictation shows."""
    import logging

    monkeypatch.setenv("ANTHROPIC_LOG", "debug")
    caplog.set_level(logging.DEBUG)
    logging.getLogger("anthropic").setLevel(logging.DEBUG)   # as ANTHROPIC_LOG would
    claude.reply = '{"sections": []}'
    await _client().complete(MESSAGES, max_tokens=2048, schema=NOTE_DRAFT_SCHEMA)
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert "cough" not in logged.lower() and "Draft the note" not in logged
    assert FAKE_KEY not in logged


def test_cores_key_setting_wins_over_the_environment(clean_env: pytest.MonkeyPatch) -> None:
    """Core's ``claude_api_key`` (OpenBao) is passed in by the route; the environment variable is
    the laptop's fallback."""
    clean_env.setenv(config.API_KEY_ENV, "laptop-placeholder")
    model = config.configured_model(api_key=FAKE_KEY)
    assert isinstance(model, ClaudeClient) and model.api_key == FAKE_KEY
    clean_env.delenv(config.API_KEY_ENV)
    assert isinstance(config.configured_model(api_key=FAKE_KEY), ClaudeClient)


def test_cores_environment_decides_where_the_stub_answers(clean_env: pytest.MonkeyPatch) -> None:
    assert isinstance(config.configured_model(environment="development"), StubModel)
    assert isinstance(config.configured_model(environment="production"),
                      config.UnconfiguredModel)


async def test_the_cache_breakpoint_goes_on_the_marked_block(claude: StubClaudeServer) -> None:
    """Consecutive user messages are one turn of text blocks; the chart block carries the cache
    breakpoint, so follow-up questions reuse the system prompt and the chart."""
    claude.reply = '{"statements": [], "insufficientEvidence": true}'
    await _client().complete([
        {"role": "system", "content": "Answer from the chart."},
        {"role": "user", "content": "Chart:\nS1: Allergy: Peanuts", "cache": "ephemeral"},
        {"role": "user", "content": "Question: Any allergies?"}], max_tokens=1000)
    [turn] = claude.requests[0]["messages"]
    assert turn["role"] == "user"
    assert turn["content"] == [
        {"type": "text", "text": "Chart:\nS1: Allergy: Peanuts",
         "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": "Question: Any allergies?"}]
