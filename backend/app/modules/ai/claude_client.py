"""The Claude API behind the gateway: Anthropic's Messages API through the official SDK
(``anthropic``). One request, one reply; no Batch API, no Files API, no tools.

The reply is constrained to the gateway's JSON Schema with structured outputs
(``output_config.format``), so it parses; the gateway still checks it (output.prune), because
structured outputs do not enforce lengths or patterns. Thinking is left to the model
(adaptive); ``effort`` sets how much, and therefore most of the cost.

Like the other clients, errors carry a kind and never a request or response body, and nothing
here logs, nor does the SDK (``quiet_sdk_logs``): no prompt, dictation, draft or patient data
reaches a log, an exception message or a traceback. The API key is the workspace's key from
the API container's environment (config.py); it is kept out of ``repr`` and is never sent
anywhere but Anthropic.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import anthropic
from anthropic.types import (
    AssistantMessageParam,
    MessageParam,
    OutputConfigParam,
    UserMessageParam,
)

from .model_client import ModelError, ModelReply

#: The SDK logs whole request bodies (the dictation, the chart lines) at DEBUG, and
#: ANTHROPIC_LOG=debug turns that on. Its loggers stay at WARNING, set here and before each call,
#: so no setting of ours or the environment's can make it log patient data.
SDK_LOGGERS = ("anthropic", "anthropic._base_client", "httpx2", "httpcore2")


def quiet_sdk_logs() -> None:
    for name in SDK_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


quiet_sdk_logs()

Effort = Literal["low", "medium", "high", "xhigh", "max"]
EFFORTS: tuple[Effort, ...] = ("low", "medium", "high", "xhigh", "max")

#: The JSON Schema keywords structured outputs accept. Our schemas' other keywords (lengths,
#: patterns, item counts) are dropped from what is sent and checked on the reply instead.
_WIRE = frozenset({"type", "properties", "required", "additionalProperties", "items", "enum",
                   "const", "$ref", "$defs", "description"})


def wire_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """``schema`` as ``output_config.format`` takes it: supported keywords only, and every
    object closed (``additionalProperties: false``)."""
    out: dict[str, Any] = {}
    for key, value in schema.items():
        if key not in _WIRE:
            continue
        if key in ("properties", "$defs"):
            out[key] = {name: wire_schema(sub) for name, sub in value.items()}
        elif key == "items" and isinstance(value, Mapping):
            out[key] = wire_schema(value)
        else:
            out[key] = value
    if out.get("type") == "object":
        out["additionalProperties"] = False
    return out


@dataclass(frozen=True)
class ClaudeClient:
    """``model`` on the Claude API (``claude-sonnet-5-5`` by default; a setting, config.py).

    ``base_url`` is for tests (a local stand-in server). ``max_tokens`` is the floor for the
    reply's ceiling: thinking counts toward it, so the gateway's own, smaller limit would cut
    a reply short.
    """
    model: str
    api_key: str = field(repr=False)
    effort: Effort = "low"
    timeout: float = 90.0
    max_retries: int = 1
    max_tokens: int = 16000
    base_url: str | None = None

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        system = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        turns: list[MessageParam] = []
        for m in messages:
            if m["role"] == "assistant":
                turns.append(AssistantMessageParam(role="assistant", content=m["content"]))
            elif m["role"] != "system":
                turns.append(UserMessageParam(role="user", content=m["content"]))
        output: OutputConfigParam = {"effort": self.effort}
        if schema is not None:
            output["format"] = {"type": "json_schema", "schema": wire_schema(schema)}
        quiet_sdk_logs()
        started = time.monotonic()
        try:
            async with anthropic.AsyncAnthropic(
                    api_key=self.api_key, base_url=self.base_url, timeout=self.timeout,
                    max_retries=self.max_retries) as client:
                message = await client.messages.create(
                    model=self.model, max_tokens=max(max_tokens, self.max_tokens),
                    system=system if system else anthropic.omit, messages=turns,
                    output_config=output)
        except anthropic.APITimeoutError:
            raise ModelError("timeout", "the model did not answer in time") from None
        except anthropic.APIConnectionError as err:
            raise ModelError("failed", f"the model is unreachable ({type(err).__name__})"
                             ) from None
        except anthropic.RateLimitError:
            raise ModelError("failed", "the model's rate limit was reached (HTTP 429)") from None
        except anthropic.APIStatusError as err:
            raise ModelError("failed", f"the model answered HTTP {err.status_code}") from None
        except anthropic.AnthropicError as err:     # e.g. no usable credential
            raise ModelError("failed", f"the model call failed ({type(err).__name__})"
                             ) from None
        usage = message.usage
        tokens_in = (usage.input_tokens + (usage.cache_creation_input_tokens or 0)
                     + (usage.cache_read_input_tokens or 0))
        if message.stop_reason == "refusal":
            category = message.stop_details.category if message.stop_details else None
            raise ModelError("declined",
                             f"the model declined the request ({category or 'no category'})",
                             prompt_tokens=tokens_in, completion_tokens=usage.output_tokens,
                             model=message.model)
        if message.stop_reason == "max_tokens":
            raise ModelError("failed", "the model's reply was cut off (max_tokens)",
                             prompt_tokens=tokens_in, completion_tokens=usage.output_tokens,
                             model=message.model)
        content = next((block.text for block in message.content if block.type == "text"), "")
        return ModelReply(content=content, model=message.model,
                          latency_ms=int((time.monotonic() - started) * 1000),
                          prompt_tokens=tokens_in, completion_tokens=usage.output_tokens)
