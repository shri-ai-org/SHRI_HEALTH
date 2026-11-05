"""Speech to text behind the AI-01 recording: an interface, and a client for an
OpenAI-compatible transcription endpoint (``/v1/audio/transcriptions``), which faster-whisper
servers expose, on the GPU server Thulasi secures. A real model is a configuration change
(``speech_config``), never a code change.

The client returns the contract's segment shape (``TranscriptSegment``: sequence, start and end
in milliseconds, text, a confidence band). Errors carry a kind and never a request or response
body, so no audio or transcript text reaches a log, an exception message or a traceback.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

Confidence = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class SpeechSegment:
    sequence: int
    start_ms: int
    end_ms: int
    text: str
    confidence: Confidence


@dataclass(frozen=True)
class SpeechReply:
    segments: tuple[SpeechSegment, ...]
    language: str | None
    model: str
    latency_ms: int


class SpeechError(Exception):
    """The transcription failed. ``kind`` only; the message never holds a body."""

    def __init__(self, kind: Literal["timeout", "failed"], detail: str) -> None:
        super().__init__(detail)
        self.kind = kind


class SpeechClient(Protocol):
    @property
    def model(self) -> str: ...

    async def transcribe(self, audio: bytes, *, content_type: str,
                         language: str | None = None) -> SpeechReply: ...


def band(avg_logprob: float | None) -> Confidence:
    """Whisper's average log-probability of a segment as the contract's band (D70). A fixed
    rule, a starting point to tune on the evaluation set: high above -0.3, low below -0.8."""
    if avg_logprob is None:
        return "medium"
    if avg_logprob > -0.3:
        return "high"
    if avg_logprob < -0.8:
        return "low"
    return "medium"


@dataclass(frozen=True)
class OpenAICompatibleSpeech:
    """One served speech model at ``base_url`` (e.g. ``http://gpu-host:8001/v1``).

    ``token`` is the speech server's machine credential (Thulasi), never a user's token.
    ``transport`` is for tests (``httpx.MockTransport``)."""
    base_url: str
    model: str
    token: str | None = None
    timeout: float = 300.0
    transport: httpx.AsyncBaseTransport | None = None

    async def transcribe(self, audio: bytes, *, content_type: str,
                         language: str | None = None) -> SpeechReply:
        data: dict[str, Any] = {"model": self.model, "response_format": "verbose_json",
                                "temperature": "0"}
        if language:
            data["language"] = language.split("-")[0]  # Whisper takes ISO 639-1 ("en")
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=self.timeout, transport=self.transport,
                                         follow_redirects=False) as client:
                response = await client.post(
                    self.base_url.rstrip("/") + "/audio/transcriptions", data=data,
                    files={"file": ("recording", audio, content_type)}, headers=headers)
        except httpx.TimeoutException:
            raise SpeechError("timeout", "the speech server did not answer in time") from None
        except httpx.HTTPError as err:
            raise SpeechError("failed", f"the speech server is unreachable "
                              f"({type(err).__name__})") from None
        if response.status_code != 200:
            raise SpeechError("failed", f"the speech server answered HTTP {response.status_code}")
        try:
            payload = response.json()
            raw = payload["segments"]
            segments = tuple(SpeechSegment(
                sequence=n, start_ms=round(float(s["start"]) * 1000),
                end_ms=round(float(s["end"]) * 1000), text=str(s["text"]).strip(),
                confidence=band(s.get("avg_logprob")))
                for n, s in enumerate(raw, start=1) if str(s.get("text", "")).strip())
        except (ValueError, KeyError, TypeError):
            raise SpeechError("failed", "the speech server's reply has no segments") from None
        return SpeechReply(segments=segments, language=payload.get("language"),
                           model=str(payload.get("model") or self.model),
                           latency_ms=int((time.monotonic() - started) * 1000))


class UnconfiguredSpeech:
    """No speech server is configured: every call fails, and says so."""
    model = "unconfigured"

    async def transcribe(self, audio: bytes, *, content_type: str,
                         language: str | None = None) -> SpeechReply:
        raise SpeechError("failed", "no speech server is configured")
