"""Download-link tokens (core/download_tokens.py): bound to one file, user and clinic, about a
minute, accepted once; every bad token is the same None. Secrets made at run time; synthetic IDs."""

import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import uuid4

import pytest
from fastapi import FastAPI
from pydantic import SecretStr
from starlette.requests import Request

from app.core.config import Settings
from app.core.download_tokens import TTL_SECONDS, DownloadTokens, download_tokens, register
from app.core.errors import ServiceUnavailable

SECRET = secrets.token_hex(32)


class Clock:
    def __init__(self) -> None:
        self.now = 1_900_000_000.0

    def __call__(self) -> float:
        return self.now


def _tokens(clock: Clock | None = None, secret: str = SECRET) -> DownloadTokens:
    return DownloadTokens(secret, clock or Clock())


def _signed(tokens: DownloadTokens) -> tuple[str, Any]:
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    return tokens.sign(claims), claims


def test_a_token_round_trips_to_its_claims_once() -> None:
    tokens = _tokens()
    token, claims = _signed(tokens)
    # The contract's pattern (contracts/openapi/modules/files.yaml, `token`), checked here too.
    assert re.fullmatch(r"^[A-Za-z0-9_-]{32,512}$", token)
    assert tokens.verify(token, user_id=claims.user_id) == claims
    assert tokens.verify(token, user_id=claims.user_id) is None  # used


def test_it_expires_after_a_minute() -> None:
    clock = Clock()
    tokens = _tokens(clock)
    token, claims = _signed(tokens)
    assert claims.expires_at == datetime.fromtimestamp(clock.now + TTL_SECONDS, UTC)
    clock.now += TTL_SECONDS
    assert tokens.verify(token, user_id=claims.user_id) is None


@pytest.mark.parametrize("other", ["user_id", "file_id", "tenant_id"])
def test_a_token_for_another_user_file_or_clinic_is_refused_and_not_used_up(other: str) -> None:
    tokens = _tokens()
    token, claims = _signed(tokens)
    mine = {"user_id": claims.user_id, "file_id": claims.file_id, "tenant_id": claims.tenant_id}
    assert tokens.verify(token, **{**mine, other: uuid4()}) is None
    assert tokens.verify(token, **mine) == claims


def test_tokens_differ_even_for_the_same_file_and_user() -> None:
    tokens = _tokens()
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    assert tokens.sign(claims) != tokens.sign(claims)  # a fresh nonce each time


def _flip(text: str, at: int) -> str:
    return text[:at] + ("A" if text[at] != "A" else "B") + text[at + 1:]


def test_a_changed_or_forged_token_is_refused() -> None:
    tokens = _tokens()
    token, claims = _signed(tokens)
    payload, signature = token[:-43], token[-43:]
    for bad in (_flip(payload, 3) + signature, payload + _flip(signature, 3),
                _tokens(secret=secrets.token_hex(32)).sign(claims),  # another key
                payload, signature, token + "x", token[1:], token + ".x", "", "a" * 2000,
                "not a token"):
        assert tokens.verify(bad, user_id=claims.user_id) is None, bad[:20]
    assert tokens.verify(token, user_id=claims.user_id) == claims  # the real one still works


def test_a_valid_signature_over_junk_is_still_none() -> None:
    tokens = _tokens()
    import base64

    payload = base64.urlsafe_b64encode(b'{"f":"x"}').decode().rstrip("=")
    assert tokens.verify(payload + tokens._signature(payload)) is None  # noqa: SLF001


@pytest.mark.parametrize("seconds", [-1, 0, TTL_SECONDS + 5, 3600])
def test_only_a_link_for_the_next_minute_can_be_signed(seconds: int) -> None:
    clock = Clock()
    tokens = _tokens(clock)
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    late = type(claims)(claims.file_id, claims.user_id, claims.tenant_id,
                        datetime.fromtimestamp(clock.now, UTC) + timedelta(seconds=seconds))
    with pytest.raises(ValueError):
        tokens.sign(late)


def _request(app: FastAPI) -> Request:
    return Request({"type": "http", "app": app, "method": "GET", "path": "/", "headers": []})


@pytest.mark.parametrize("secret", [None, "too-short"])
def test_without_a_proper_session_secret_downloads_are_503(secret: str | None) -> None:
    app = FastAPI()
    register(app, Settings(environment="test",
                           session_secret=SecretStr(secret) if secret else None))
    assert app.state.download_tokens is None
    with pytest.raises(ServiceUnavailable):
        download_tokens(_request(app))


def test_the_app_has_one_token_keeper_keyed_apart_from_csrf() -> None:
    from app.core.session import csrf_token

    settings = Settings(environment="test", session_secret=SecretStr(SECRET))
    app = FastAPI()
    register(app, settings)
    tokens = download_tokens(_request(app))
    token, _ = _signed(tokens)
    payload, signature = token[:-43], token[-43:]
    assert csrf_token(settings, payload) != signature
