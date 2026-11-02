"""The prompt and a minimal OpenAI-compatible chat client (vLLM's ``/v1/chat/completions``).

Standard library only (urllib). Errors never carry the request or response body, so no
transcript or draft text reaches a log or a traceback.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from . import PROMPT_VERSION
from .dataset import Visit

SYSTEM_PROMPT = "\n".join((
    "You draft a clinical note from a visit transcript, for the clinician to review and sign.",
    "Return only a JSON object, with no other text:",
    '{"sections": [{"code": "<section code>", "text": "<section text>"}], '
    '"unknowns": ["<item>"]}',
    "Rules:",
    "- Use only the section codes listed below, each at most once, in the order listed.",
    "- Write only what the transcript or the patient line states. Never add findings, tests, "
    "medicines, doses, diagnoses or history that were not said.",
    "- When someone corrects an earlier statement, use the correction.",
    "- Leave a section's text empty when the visit gave nothing for it.",
    '- Put anything a complete note would need but the visit did not say in "unknowns".',
    "- Plain clinical English; no Markdown.",
))


def messages(visit: Visit) -> list[dict[str, str]]:
    sections = "\n".join(f"- {code}: {title}{' (required)' if required else ''}"
                         for code, title, required in visit.template)
    return [
        {"role": "system", "content": f"{SYSTEM_PROMPT}\nSections:\n{sections}"},
        {"role": "user", "content": f"Patient: {visit.context}.\nTranscript:\n"
                                    f"{visit.transcript_text}"},
    ]


class EndpointError(Exception):
    """The endpoint failed. The message names the status only, never a body."""


@dataclass(frozen=True)
class Reply:
    content: str
    latency_ms: int
    prompt_tokens: int | None
    completion_tokens: int | None


def redact_url(url: str) -> str:
    """The URL without user info, query or fragment, safe for a report."""
    parts = urlsplit(url)
    host = parts.hostname or ""
    if parts.port:
        host = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme, host, parts.path, "", ""))


@dataclass(frozen=True)
class ChatClient:
    endpoint: str          # base URL, e.g. http://gpu-host:8000/v1
    model: str
    api_key: str | None = None
    timeout: float = 300.0
    max_tokens: int = 2048
    temperature: float = 0.0
    json_mode: bool = False
    no_thinking: bool = False

    def complete(self, msgs: list[dict[str, str]]) -> Reply:
        body: dict[str, Any] = {"model": self.model, "messages": msgs,
                                "temperature": self.temperature, "max_tokens": self.max_tokens}
        if self.json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.no_thinking:      # Qwen3-family chat templates (vLLM passes it through)
            body["chat_template_kwargs"] = {"enable_thinking": False}
        url = self.endpoint.rstrip("/") + "/chat/completions"
        if urlsplit(url).scheme not in ("http", "https"):
            raise EndpointError("the endpoint must be an http or https URL")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(  # noqa: S310 (http or https only, checked above)
            url, data=json.dumps(body).encode(), headers=headers, method="POST")
        started = time.monotonic()
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as resp:  # noqa: S310
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as err:
            raise EndpointError(f"HTTP {err.code}") from None
        except (urllib.error.URLError, TimeoutError) as err:
            raise EndpointError(f"unreachable ({type(err).__name__})") from None
        except json.JSONDecodeError:
            raise EndpointError("the reply was not JSON") from None
        latency = int((time.monotonic() - started) * 1000)
        try:
            content = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError):
            raise EndpointError("the reply has no choices[0].message.content") from None
        usage = payload.get("usage") or {}
        return Reply(content=str(content), latency_ms=latency,
                     prompt_tokens=usage.get("prompt_tokens"),
                     completion_tokens=usage.get("completion_tokens"))


__all__ = ["PROMPT_VERSION", "ChatClient", "EndpointError", "Reply", "messages", "redact_url"]
