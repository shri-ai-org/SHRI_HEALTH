"""The OpenAI-compatible model client against httpx's mock transport (no network)."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from app.modules.ai.model_client import ModelError, OpenAICompatibleClient

MESSAGES = [{"role": "system", "content": "Draft."}, {"role": "user", "content": "Transcript"}]


def _client(handler: Any, **kw: Any) -> OpenAICompatibleClient:
    return OpenAICompatibleClient(base_url="http://gpu-host:8000/v1/", model="Qwen/Qwen3-8B",
                                  transport=httpx.MockTransport(handler), **kw)


async def test_a_reply_with_its_usage() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={
            "model": "Qwen/Qwen3-8B", "usage": {"prompt_tokens": 10, "completion_tokens": 5},
            "choices": [{"message": {"role": "assistant", "content": '{"sections": []}'}}]})

    client = _client(handler, token="machine-token-for-tests",
                     extra={"chat_template_kwargs": {"enable_thinking": False}})
    reply = await client.complete(MESSAGES, max_tokens=256)
    assert reply.content == '{"sections": []}' and reply.model == "Qwen/Qwen3-8B"
    assert (reply.prompt_tokens, reply.completion_tokens) == (10, 5) and reply.latency_ms >= 0
    assert seen["url"] == "http://gpu-host:8000/v1/chat/completions"
    assert seen["auth"] == "Bearer machine-token-for-tests"
    assert seen["body"] == {"model": "Qwen/Qwen3-8B", "messages": MESSAGES, "temperature": 0.0,
                            "max_tokens": 256, "response_format": {"type": "json_object"},
                            "chat_template_kwargs": {"enable_thinking": False}}


@pytest.mark.parametrize(("response", "message"), [
    (httpx.Response(500, text="echo: Transcript"), "the model answered HTTP 500"),
    (httpx.Response(200, text="not json"), "the model's reply has no message content"),
    (httpx.Response(200, json={"choices": []}), "the model's reply has no message content"),
])
async def test_failures_never_carry_a_body(response: httpx.Response, message: str) -> None:
    with pytest.raises(ModelError) as failed:
        await _client(lambda _: response).complete(MESSAGES, max_tokens=8)
    assert failed.value.kind == "failed" and str(failed.value) == message
    assert "Transcript" not in str(failed.value)


@pytest.mark.parametrize(("error", "kind"), [(httpx.ReadTimeout("slow"), "timeout"),
                                             (httpx.ConnectError("refused"), "failed")])
async def test_timeouts_and_connection_errors(error: Exception, kind: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(ModelError) as failed:
        await _client(handler).complete(MESSAGES, max_tokens=8)
    assert failed.value.kind == kind and failed.value.__cause__ is None
