"""Which model the gateway calls.

TEMPORARY SEAM. Core has no model-server setting yet (the GPU server, its address and its machine
credential are Thulasi's, Vimal's guide Step 7.1), so it comes from environment variables, as the
file service's store does (``files.storage.configured_store``):

- ``SHRI_AI_MODEL_URL``: the OpenAI-compatible base URL, e.g. ``http://gpu-host:8000/v1``;
- ``SHRI_AI_MODEL_NAME``: the served model's name;
- ``SHRI_AI_MODEL_TOKEN``: the model server's machine credential, never a user's token.

Without a URL and a name the gateway still runs: every model call fails as "the model is
unavailable", so a note draft's operation ends ``failed`` and nothing else changes. When core's
setting lands, only this function changes.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from urllib.parse import urlsplit

from .model_client import ModelClient, ModelError, ModelReply, OpenAICompatibleClient
from .speech_client import OpenAICompatibleSpeech, SpeechClient, UnconfiguredSpeech

MODEL_URL_ENV = "SHRI_AI_MODEL_URL"
MODEL_NAME_ENV = "SHRI_AI_MODEL_NAME"
MODEL_TOKEN_ENV = "SHRI_AI_MODEL_TOKEN"  # noqa: S105 (the variable's name, not a secret)
# The speech server (faster-whisper behind an OpenAI-compatible /v1/audio/transcriptions), the
# same way: a URL, the served model's name and its machine credential.
SPEECH_URL_ENV = "SHRI_AI_SPEECH_URL"
SPEECH_MODEL_ENV = "SHRI_AI_SPEECH_MODEL"
SPEECH_TOKEN_ENV = "SHRI_AI_SPEECH_TOKEN"  # noqa: S105 (the variable's name, not a secret)


class UnconfiguredModel:
    """No model server is configured: every call fails, and says so in the request record."""
    model = "unconfigured"

    async def complete(self, messages: Sequence[Mapping[str, str]], *,
                       max_tokens: int) -> ModelReply:
        raise ModelError("failed", "no model server is configured")


def configured_model() -> ModelClient:
    """FastAPI dependency: the configured model server, or ``UnconfiguredModel``."""
    url, name = os.environ.get(MODEL_URL_ENV, ""), os.environ.get(MODEL_NAME_ENV, "")
    if not url or not name or urlsplit(url).scheme not in ("http", "https"):
        return UnconfiguredModel()
    return OpenAICompatibleClient(base_url=url, model=name,
                                  token=os.environ.get(MODEL_TOKEN_ENV) or None)


def configured_speech() -> SpeechClient:
    """FastAPI dependency: the configured speech server, or ``UnconfiguredSpeech``."""
    url, name = os.environ.get(SPEECH_URL_ENV, ""), os.environ.get(SPEECH_MODEL_ENV, "")
    if not url or not name or urlsplit(url).scheme not in ("http", "https"):
        return UnconfiguredSpeech()
    return OpenAICompatibleSpeech(base_url=url, model=name,
                                  token=os.environ.get(SPEECH_TOKEN_ENV) or None)
