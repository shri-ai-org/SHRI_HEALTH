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
from app.core.download_tokens import (
    TTL_SECONDS,
    DownloadTokens,
    PortalDownloadTokens,
    download_tokens,
    portal_download_tokens,
    register,
)
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


def _bound(claims: Any) -> dict[str, Any]:
    return {"user_id": claims.user_id, "file_id": claims.file_id, "tenant_id": claims.tenant_id}


@pytest.mark.parametrize("left_out", ["user_id", "file_id", "tenant_id"])
def test_the_binding_cannot_be_skipped(left_out: str) -> None:
    """Vimal's review of #140: every caller names the user, file and clinic."""
    tokens = _tokens()
    token, claims = _signed(tokens)
    partial = {k: v for k, v in _bound(claims).items() if k != left_out}
    with pytest.raises(TypeError):
        tokens.verify(token, **partial)
    assert tokens.verify(token, **_bound(claims)) == claims  # and nothing was used up


def test_a_token_round_trips_to_its_claims_once() -> None:
    tokens = _tokens()
    token, claims = _signed(tokens)
    # The contract's pattern (contracts/openapi/modules/files.yaml, `token`), checked here too.
    assert re.fullmatch(r"^[A-Za-z0-9_-]{32,512}$", token)
    assert tokens.verify(token, **_bound(claims)) == claims
    assert tokens.verify(token, **_bound(claims)) is None  # used


def test_it_expires_after_a_minute() -> None:
    clock = Clock()
    tokens = _tokens(clock)
    token, claims = _signed(tokens)
    assert claims.expires_at == datetime.fromtimestamp(clock.now + TTL_SECONDS, UTC)
    clock.now += TTL_SECONDS
    assert tokens.verify(token, **_bound(claims)) is None


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
        assert tokens.verify(bad, **_bound(claims)) is None, bad[:20]
    assert tokens.verify(token, **_bound(claims)) == claims  # the real one still works


def test_a_valid_signature_over_junk_is_still_none() -> None:
    tokens = _tokens()
    import base64

    payload = base64.urlsafe_b64encode(b'{"f":"x"}').decode().rstrip("=")
    forged = payload + tokens._signature(payload)  # noqa: SLF001
    assert tokens.verify(forged, user_id=uuid4(), file_id=uuid4(), tenant_id=uuid4()) is None


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


# ------------------------------------------------- the patient portal's links (#398, #330)
def _portal(clock: Clock | None = None, secret: str = SECRET) -> PortalDownloadTokens:
    return PortalDownloadTokens(secret, clock or Clock())


def _portal_signed(tokens: PortalDownloadTokens) -> tuple[str, Any]:
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    return tokens.sign(claims), claims


def _patient(claims: Any) -> dict[str, Any]:
    return {"patient_id": claims.patient_id, "file_id": claims.file_id,
            "tenant_id": claims.tenant_id}


def test_a_portal_token_round_trips_once_for_its_patient() -> None:
    tokens = _portal()
    token, claims = _portal_signed(tokens)
    assert re.fullmatch(r"^[A-Za-z0-9_-]{32,512}$", token)  # the contract's pattern
    assert tokens.verify(token, **_patient(claims)) == claims
    assert tokens.verify(token, **_patient(claims)) is None  # a reused token is refused


@pytest.mark.parametrize("left_out", ["patient_id", "file_id", "tenant_id"])
def test_the_portal_binding_cannot_be_skipped(left_out: str) -> None:
    tokens = _portal()
    token, claims = _portal_signed(tokens)
    with pytest.raises(TypeError):
        tokens.verify(token, **{k: v for k, v in _patient(claims).items() if k != left_out})
    assert tokens.verify(token, **_patient(claims)) == claims


@pytest.mark.parametrize("other", ["patient_id", "file_id", "tenant_id"])
def test_a_portal_token_for_another_patient_file_or_clinic_is_refused(other: str) -> None:
    tokens = _portal()
    token, claims = _portal_signed(tokens)
    assert tokens.verify(token, **{**_patient(claims), other: uuid4()}) is None
    assert tokens.verify(token, **_patient(claims)) == claims  # not used up by the refusal


def test_a_portal_token_expires_after_a_minute() -> None:
    clock = Clock()
    tokens = _portal(clock)
    token, claims = _portal_signed(tokens)
    assert claims.expires_at == datetime.fromtimestamp(clock.now + TTL_SECONDS, UTC)
    clock.now += TTL_SECONDS
    assert tokens.verify(token, **_patient(claims)) is None


@pytest.mark.parametrize("seconds", [-1, 0, TTL_SECONDS + 5, 3600])
def test_only_a_portal_link_for_the_next_minute_can_be_signed(seconds: int) -> None:
    clock = Clock()
    tokens = _portal(clock)
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    late = type(claims)(claims.file_id, claims.patient_id, claims.tenant_id,
                        datetime.fromtimestamp(clock.now, UTC) + timedelta(seconds=seconds))
    with pytest.raises(ValueError):
        tokens.sign(late)


def test_a_changed_forged_or_malformed_portal_token_is_refused() -> None:
    tokens = _portal()
    token, claims = _portal_signed(tokens)
    payload, signature = token[:-43], token[-43:]
    for bad in (_flip(payload, 3) + signature, payload + _flip(signature, 3),
                _portal(secret=secrets.token_hex(32)).sign(claims), payload, "", "a" * 2000,
                "not a token", token + "x"):
        assert tokens.verify(bad, **_patient(claims)) is None, bad[:20]
    assert tokens.verify(token, **_patient(claims)) == claims


def test_a_staff_token_never_works_on_the_portal_route_nor_the_reverse() -> None:
    """Same secret, same file, same subject ID and clinic: still refused across routes, by the
    key's label and by the payload's audience."""
    clock = Clock()
    staff, portal = _tokens(clock), _portal(clock)
    file_id, subject, clinic = uuid4(), uuid4(), uuid4()
    staff_token = staff.sign(staff.claims(file_id, subject, clinic))
    portal_token = portal.sign(portal.claims(file_id, subject, clinic))
    assert portal.verify(staff_token, patient_id=subject, file_id=file_id,
                         tenant_id=clinic) is None
    assert staff.verify(portal_token, user_id=subject, file_id=file_id, tenant_id=clinic) is None
    # Each still works on its own route: the refusals used nothing up.
    assert staff.verify(staff_token, user_id=subject, file_id=file_id, tenant_id=clinic)
    assert portal.verify(portal_token, patient_id=subject, file_id=file_id, tenant_id=clinic)


def test_a_portal_payload_re_signed_with_the_staff_audience_is_refused() -> None:
    """The audience is checked on its own too: a payload naming the staff audience, signed with
    the portal key, is refused."""
    import base64
    import json

    tokens = _portal()
    claims = tokens.claims(uuid4(), uuid4(), uuid4())
    body = {"a": "staff", "f": str(claims.file_id), "u": str(claims.patient_id),
            "t": str(claims.tenant_id), "e": int(claims.expires_at.timestamp()), "n": "x" * 22}
    payload = base64.urlsafe_b64encode(
        json.dumps(body, separators=(",", ":")).encode()).decode().rstrip("=")
    forged = payload + tokens._signature(payload)  # noqa: SLF001
    assert tokens.verify(forged, **_patient(claims)) is None


@pytest.mark.parametrize("secret", [None, "too-short"])
def test_without_a_proper_session_secret_portal_downloads_are_503(secret: str | None) -> None:
    app = FastAPI()
    register(app, Settings(environment="test",
                           session_secret=SecretStr(secret) if secret else None))
    assert app.state.portal_download_tokens is None
    with pytest.raises(ServiceUnavailable):
        portal_download_tokens(_request(app))


def test_the_app_has_a_portal_token_keeper_apart_from_the_staff_one() -> None:
    app = FastAPI()
    register(app, Settings(environment="test", session_secret=SecretStr(SECRET)))
    assert isinstance(portal_download_tokens(_request(app)), PortalDownloadTokens)
    assert portal_download_tokens(_request(app)) is not download_tokens(_request(app))
