"""Which model the gateway calls: the provider and the model are settings.

TEMPORARY SEAM. Core has no AI settings yet, so they come from the API container's environment
variables, as the file service's store does (``files.storage.configured_store``):

- ``SHRI_AI_PROVIDER``: ``claude`` (the Claude API), ``openai-compatible`` (a model server such
  as vLLM) or ``stub`` (no model: a fixed fictional draft, stub_model.py). Not set: ``claude``
  when core has a Claude API key, ``openai-compatible`` when ``SHRI_AI_MODEL_URL`` is set, else
  ``stub``, so a laptop without a key still runs the whole flow.
- ``SHRI_AI_MODEL``: the Claude model, ``claude-sonnet-5-5`` unless set (``claude-haiku-5-5``
  is this one line); ``SHRI_AI_EFFORT``: ``low`` unless set.
- The workspace's key: **only** core's ``claude_api_key`` setting (OpenBao KV
  ``CLAUDE_API_KEY``, read at startup, a SecretStr; #257), never the environment, code or a
  file. On a laptop the key is loaded into the local OpenBao the same way. It is handed to the
  client only: never logged, never returned by an endpoint, never sent to a screen.
- ``SHRI_AI_MODEL_URL``, ``SHRI_AI_MODEL_NAME``, ``SHRI_AI_MODEL_TOKEN``: the OpenAI-compatible
  server's base URL, served model and machine credential (never a user's token).

A provider that is chosen but not usable (``claude`` without a key, ``stub`` outside development,
test and staging) is
``UnconfiguredModel``: every model call fails as "the model is unavailable", so a note draft's
operation ends ``failed`` and nothing else changes. When core's settings land, only this module
changes.
"""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

from .claude_client import EFFORTS, ClaudeClient, Effort
from .model_client import ModelClient, ModelError, ModelReply, OpenAICompatibleClient
from .speech_client import OpenAICompatibleSpeech, SpeechClient, UnconfiguredSpeech
from .stub_model import StubModel

PROVIDER_ENV = "SHRI_AI_PROVIDER"
CLAUDE_MODEL_ENV = "SHRI_AI_MODEL"
EFFORT_ENV = "SHRI_AI_EFFORT"
DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5"
DEFAULT_EFFORT: Effort = "low"
MODEL_URL_ENV = "SHRI_AI_MODEL_URL"
MODEL_NAME_ENV = "SHRI_AI_MODEL_NAME"
MODEL_TOKEN_ENV = "SHRI_AI_MODEL_TOKEN"  # noqa: S105 (the variable's name, not a secret)
# The speech server (faster-whisper behind an OpenAI-compatible /v1/audio/transcriptions), the
# same way: a URL, the served model's name and its machine credential.
SPEECH_URL_ENV = "SHRI_AI_SPEECH_URL"
SPEECH_MODEL_ENV = "SHRI_AI_SPEECH_MODEL"
SPEECH_TOKEN_ENV = "SHRI_AI_SPEECH_TOKEN"  # noqa: S105 (the variable's name, not a secret)
#: Core's ENVIRONMENT (app.core.settings.base). Unset means production there, so the stub
#: answers only where it is explicitly one of these.
ENVIRONMENT_ENV = "ENVIRONMENT"
ON_BY_DEFAULT_ENV = "SHRI_AI_ON_BY_DEFAULT"
#: On a demo server (SHRI_DEMO=true; the deploy kit sets this from it) an AI feature that was never
#: set is on, so AI is on after every reset; the admin's switch still turns it off (D118).
#: Ignored in production, where a feature never set stays off until the ADR-08 decision.
STUB_ENVIRONMENTS = frozenset({"development", "test", "staging"})



class UnconfiguredModel:
    """No usable model is configured: every call fails, and says so in the request record."""
    model = "unconfigured"

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        raise ModelError("failed", "no model is configured")


def provider(api_key: str | None = None) -> str:
    """The provider in effect: the setting, or the default for what is configured."""
    chosen = os.environ.get(PROVIDER_ENV, "").strip().lower()
    if chosen:
        return chosen
    if api_key:
        return "claude"
    if os.environ.get(MODEL_URL_ENV):
        return "openai-compatible"
    return "stub"


def _claude(api_key: str | None) -> ModelClient:
    key = api_key
    if not key:
        return UnconfiguredModel()
    wanted = os.environ.get(EFFORT_ENV, "").strip().lower()
    effort = next((e for e in EFFORTS if e == wanted), DEFAULT_EFFORT)
    return ClaudeClient(model=os.environ.get(CLAUDE_MODEL_ENV, "").strip() or DEFAULT_CLAUDE_MODEL,
                        api_key=key, effort=effort)


def _openai_compatible() -> ModelClient:
    url, name = os.environ.get(MODEL_URL_ENV, ""), os.environ.get(MODEL_NAME_ENV, "")
    if not url or not name or urlsplit(url).scheme not in ("http", "https"):
        return UnconfiguredModel()
    return OpenAICompatibleClient(base_url=url, model=name,
                                  token=os.environ.get(MODEL_TOKEN_ENV) or None)


def configured_model(api_key: str | None = None, environment: str | None = None
                     ) -> ModelClient:
    """The configured provider's client, or ``UnconfiguredModel``. ``api_key`` is core's
    ``claude_api_key`` (api.py), the only source of the key; ``environment`` is core's too."""
    chosen = provider(api_key)
    if chosen == "claude":
        return _claude(api_key)
    if chosen == "openai-compatible":
        return _openai_compatible()
    where = (environment or os.environ.get(ENVIRONMENT_ENV, "")).lower()
    if chosen == "stub" and where in STUB_ENVIRONMENTS:
        return StubModel()
    return UnconfiguredModel()


def configured_speech() -> SpeechClient:
    """FastAPI dependency: the configured speech server, or ``UnconfiguredSpeech``."""
    url, name = os.environ.get(SPEECH_URL_ENV, ""), os.environ.get(SPEECH_MODEL_ENV, "")
    if not url or not name or urlsplit(url).scheme not in ("http", "https"):
        return UnconfiguredSpeech()
    return OpenAICompatibleSpeech(base_url=url, model=name,
                                  token=os.environ.get(SPEECH_TOKEN_ENV) or None)


def features_on_by_default() -> bool:
    """Whether an AI feature with no setting is on: only when ``SHRI_AI_ON_BY_DEFAULT`` is
    ``true`` (a demo server) and the environment isn't production (D118)."""
    wanted = os.environ.get(ON_BY_DEFAULT_ENV, "").strip().lower() == "true"
    return wanted and os.environ.get(ENVIRONMENT_ENV, "").strip().lower() != "production"
