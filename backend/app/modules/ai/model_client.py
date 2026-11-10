"""The model behind the gateway: an interface, and a client for an OpenAI-compatible chat
endpoint (vLLM's ``/v1/chat/completions``, on the GPU server Thulasi secures). The Claude API's
client is claude_client.py; the stand-in that calls no model is stub_model.py.

Errors carry a kind and never a request or response body, so no transcript or draft text
reaches a log, an exception message or a traceback. The tests use a stub (tests/fakes.py).
"""

from __future__ import annotations

import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx


@dataclass(frozen=True)
class ModelReply:
    content: str
    model: str
    latency_ms: int
    prompt_tokens: int | None = None
    completion_tokens: int | None = None


class ModelError(Exception):
    """The model call failed. ``kind`` only; the message never holds a body. ``declined``: the
    model answered but refused the request (a safety classifier), so there is no output."""

    def __init__(self, kind: Literal["timeout", "failed", "declined"], detail: str, *,
                 prompt_tokens: int | None = None, completion_tokens: int | None = None,
                 model: str | None = None) -> None:
        super().__init__(detail)
        self.kind = kind
        # What a reply that was refused or cut short still used (it is billed), for the record.
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.model = model


class ModelClient(Protocol):
    @property
    def model(self) -> str: ...

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        """One reply to ``messages``. ``schema`` is the JSON Schema the reply must fit; a
        client whose server can enforce it does (the Claude API's structured outputs), and the
        gateway checks the reply against it either way (output.prune)."""
        ...


@dataclass(frozen=True)
class OpenAICompatibleClient:
    """One served model at ``base_url`` (e.g. ``http://gpu-host:8000/v1``).

    ``token`` is the machine credential for the model server (Thulasi), never a user's token.
    ``transport`` is for tests (``httpx.MockTransport``). ``extra`` goes into every request,
    e.g. ``{"chat_template_kwargs": {"enable_thinking": False}}`` for the Qwen3 family.
    """
    base_url: str
    model: str
    token: str | None = None
    timeout: float = 120.0
    temperature: float = 0.0
    extra: Mapping[str, Any] | None = None
    transport: httpx.AsyncBaseTransport | None = None

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        body: dict[str, Any] = {"model": self.model, "messages": [dict(m) for m in messages],
                                "temperature": self.temperature, "max_tokens": max_tokens,
                                "response_format": {"type": "json_object"},
                                **(self.extra or {})}
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport,
                                         follow_redirects=False) as client:
                response = await client.post(self.base_url.rstrip("/") + "/chat/completions",
                                             json=body, headers=headers)
        except httpx.TimeoutException:
            raise ModelError("timeout", "the model did not answer in time") from None
        except httpx.HTTPError as err:
            raise ModelError("failed", f"the model is unreachable ({type(err).__name__})"
                             ) from None
        if response.status_code != 200:
            raise ModelError("failed", f"the model answered HTTP {response.status_code}")
        try:
            payload = response.json()
            content = payload["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError):
            raise ModelError("failed", "the model's reply has no message content") from None
        usage = payload.get("usage") or {}
        return ModelReply(content=str(content), model=str(payload.get("model") or self.model),
                          latency_ms=int((time.monotonic() - started) * 1000),
                          prompt_tokens=usage.get("prompt_tokens"),
                          completion_tokens=usage.get("completion_tokens"))
