"""The OpenAI-compatible speech client against httpx's mock transport (no network), its
confidence bands and its configuration. Synthetic text only; the audio is a few fake bytes."""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from app.modules.ai import config
from app.modules.ai.speech_client import (
    OpenAICompatibleSpeech,
    SpeechError,
    UnconfiguredSpeech,
    band,
)

AUDIO = b"RIFF0000WAVEfmt "  # not real audio; the stub never decodes it
SPOKEN = "The headaches started two weeks ago (synthetic)."


def _client(handler: Any, **kw: Any) -> OpenAICompatibleSpeech:
    return OpenAICompatibleSpeech(base_url="http://gpu-host:8001/v1/", model="large-v3-turbo",
                                  transport=httpx.MockTransport(handler), **kw)


async def test_a_transcript_as_the_contracts_segments() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"], seen["auth"] = str(request.url), request.headers.get("Authorization")
        seen["body"] = request.content
        return httpx.Response(200, json={"language": "en", "segments": [
            {"start": 0.0, "end": 2.48, "text": " Good morning. ", "avg_logprob": -0.1},
            {"start": 2.48, "end": 3.0, "text": "   ", "avg_logprob": -0.1},  # silence, dropped
            {"start": 3.0, "end": 7.25, "text": SPOKEN, "avg_logprob": -0.5},
            {"start": 7.25, "end": 8.0, "text": "mm", "avg_logprob": -1.4}]})

    reply = await _client(handler, token="machine-token-for-tests").transcribe(
        AUDIO, content_type="audio/wav", language="en-US")
    assert seen["url"] == "http://gpu-host:8001/v1/audio/transcriptions"
    assert seen["auth"] == "Bearer machine-token-for-tests"
    for field in (b'name="model"', b"large-v3-turbo", b"verbose_json", b'name="language"',
                  b"\r\n\r\nen\r\n", b'name="file"', AUDIO):
        assert field in seen["body"], field
    assert [(s.sequence, s.start_ms, s.end_ms, s.text, s.confidence) for s in reply.segments] == [
        (1, 0, 2480, "Good morning.", "high"), (3, 3000, 7250, SPOKEN, "medium"),
        (4, 7250, 8000, "mm", "low")]
    assert reply.language == "en" and reply.model == "large-v3-turbo" and reply.latency_ms >= 0


async def test_no_token_and_no_language_send_neither() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"], seen["body"] = request.headers.get("Authorization"), request.content
        return httpx.Response(200, json={"segments": []})

    reply = await _client(handler).transcribe(AUDIO, content_type="audio/webm")
    assert seen["auth"] is None and b'name="language"' not in seen["body"]
    assert reply.segments == () and reply.language is None


@pytest.mark.parametrize(("response", "kind"), [
    (httpx.Response(503, text=SPOKEN), "failed"),
    (httpx.Response(200, text="not json " + SPOKEN), "failed"),
    (httpx.Response(200, json={"text": SPOKEN}), "failed"),  # no segments
    (httpx.Response(200, json={"segments": [{"text": SPOKEN}]}), "failed"),  # no times
])
async def test_failures_carry_a_kind_and_never_the_body(response: httpx.Response,
                                                        kind: str) -> None:
    with pytest.raises(SpeechError) as err:
        await _client(lambda _r: response).transcribe(AUDIO, content_type="audio/wav")
    assert err.value.kind == kind
    assert SPOKEN not in str(err.value) and err.value.__cause__ is None


async def test_a_timeout_and_an_unreachable_server() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    with pytest.raises(SpeechError) as timed_out:
        await _client(slow).transcribe(AUDIO, content_type="audio/wav")
    assert timed_out.value.kind == "timeout"
    with pytest.raises(SpeechError) as unreachable:
        await _client(down).transcribe(AUDIO, content_type="audio/wav")
    assert unreachable.value.kind == "failed" and "ConnectError" in str(unreachable.value)


def test_the_bands() -> None:
    assert [band(v) for v in (None, -0.05, -0.3, -0.5, -0.8, -0.81)] == [
        "medium", "high", "medium", "medium", "medium", "low"]


async def test_the_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (config.SPEECH_URL_ENV, config.SPEECH_MODEL_ENV, config.SPEECH_TOKEN_ENV):
        monkeypatch.delenv(name, raising=False)
    unset = config.configured_speech()
    assert isinstance(unset, UnconfiguredSpeech)
    with pytest.raises(SpeechError) as err:
        await unset.transcribe(AUDIO, content_type="audio/wav")
    assert err.value.kind == "failed"
    monkeypatch.setenv(config.SPEECH_URL_ENV, "file:///etc/passwd")
    monkeypatch.setenv(config.SPEECH_MODEL_ENV, "large-v3-turbo")
    assert isinstance(config.configured_speech(), UnconfiguredSpeech)  # http(s) only
    monkeypatch.setenv(config.SPEECH_URL_ENV, "http://gpu-host:8001/v1")
    monkeypatch.setenv(config.SPEECH_TOKEN_ENV, "machine-token-for-tests")
    served = config.configured_speech()
    assert isinstance(served, OpenAICompatibleSpeech)
    assert (served.base_url, served.model, served.token) == (
        "http://gpu-host:8001/v1", "large-v3-turbo", "machine-token-for-tests")
