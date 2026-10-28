"""Public-form guards (D96): Origin, rate limits, the email key and the ALTCHA bot check. No
database; public_db is tested in test_public_db_postgres.py. Synthetic values only."""

import base64
import hashlib
import json
import secrets
from typing import Any

import pytest
from fastapi import Depends
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core import public_form
from app.core.config import Settings
from app.core.public_form import (
    BotCheck,
    PublicFormGuards,
    RateLimiter,
    origin_matches,
    public_form_guards,
    require_portal_origin,
)

PORTAL = "https://portal.example.test"
SECRET = secrets.token_hex(32)  # made at run time: no secret-like literal in the source


def _settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {"environment": "test", "auth_mode": "dev_header",
                              "portal_origin": PORTAL, "public_form_secret": SecretStr(SECRET),
                              "bot_check_max_number": 2000}
    values.update(overrides)
    return Settings(**values)


# ------------------------------------------------------------------------------------- Origin
@pytest.mark.parametrize("origin", [PORTAL, "HTTPS://Portal.Example.Test", f" {PORTAL} "])
def test_the_portal_origin_matches(origin: str) -> None:
    assert origin_matches(origin, PORTAL)


@pytest.mark.parametrize("origin", [None, "", "null", f"{PORTAL}/", f"{PORTAL}:443",
                                     "http://portal.example.test", "https://evil.example.test",
                                     "https://portal.example.test.evil.test", f"{PORTAL}/x"])
def test_anything_else_never_matches(origin: str | None) -> None:
    assert not origin_matches(origin, PORTAL)


def test_a_wrong_origin_is_403_and_no_portal_origin_is_503() -> None:
    from app.main import create_app

    app = create_app(_settings())

    @app.get("/form", dependencies=[Depends(require_portal_origin)])
    async def form() -> dict[str, str]:
        return {"ok": "yes"}

    client = TestClient(app)
    assert client.get("/form", headers={"Origin": PORTAL}).status_code == 200
    denied = client.get("/form", headers={"Origin": "https://evil.example.test"})
    assert denied.status_code == 403 and denied.json()["code"] == "csrf-check-failed"
    assert client.get("/form").status_code == 403  # no Origin at all

    bare = create_app(Settings(environment="test", auth_mode="dev_header"))
    bare.get("/form", dependencies=[Depends(require_portal_origin)])(form)
    assert TestClient(bare).get("/form", headers={"Origin": PORTAL}).status_code == 503


# ------------------------------------------------------------------------- configuration
def test_without_configuration_the_guards_answer_503() -> None:
    from app.main import create_app

    app = create_app(Settings(environment="test", auth_mode="dev_header"))

    @app.get("/guarded")
    async def guarded(guards: PublicFormGuards = Depends(public_form_guards)) -> dict[str, str]:
        return {"ok": "yes"}

    assert TestClient(app).get("/guarded").status_code == 503


@pytest.mark.parametrize("overrides", [
    {"portal_origin": None},  # a secret without an origin
    {"public_form_secret": None},  # an origin without a secret
    {"public_form_secret": SecretStr("too-short")},
])
def test_half_configured_public_forms_stop_startup(overrides: dict[str, Any]) -> None:
    from app.main import create_app

    with pytest.raises(ValueError):
        create_app(_settings(**overrides))


def test_one_set_of_guards_per_app() -> None:
    from app.main import create_app

    app = create_app(_settings())
    assert isinstance(getattr(app.state, public_form.STATE), PublicFormGuards)


# ------------------------------------------------------------------------------ email key
def test_the_email_key_is_a_keyed_hash_never_the_address() -> None:
    guards = PublicFormGuards(_settings())
    key = guards.email_key("kaia.lindgren@example.com")
    assert len(key) == 64 and int(key, 16) >= 0
    assert "kaia" not in key and "example" not in key
    assert key == guards.email_key("kaia.lindgren@example.com")
    assert key != guards.email_key("kaia.lindgren2@example.com")
    assert key != hashlib.sha256(b"kaia.lindgren@example.com").hexdigest()  # keyed, not plain
    other = PublicFormGuards(_settings(public_form_secret=SecretStr("x" * 40)))
    assert key != other.email_key("kaia.lindgren@example.com")


# ---------------------------------------------------------------------------- rate limits
class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_the_limit_counts_per_scope_and_key_and_resets_with_the_window() -> None:
    clock = Clock()
    limiter = RateLimiter({"ip": (2, 60), "email": (1, 3600)}, clock=clock)
    assert limiter.hit("ip", "192.0.2.1") is None
    assert limiter.hit("ip", "192.0.2.1") is None
    assert limiter.hit("ip", "192.0.2.1") == 60  # the third in the window: wait it out
    assert limiter.hit("ip", "192.0.2.2") is None  # another IP has its own count
    assert limiter.hit("email", "192.0.2.1") is None  # another scope too
    clock.now += 30
    assert limiter.hit("ip", "192.0.2.1") == 30
    clock.now += 30
    assert limiter.hit("ip", "192.0.2.1") is None  # a new window


def test_an_unknown_scope_is_a_programming_error() -> None:
    with pytest.raises(ValueError):
        RateLimiter({"ip": (1, 60)}).hit("phone", "x")


def test_the_limiter_keeps_a_bounded_number_of_counters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(public_form, "MAX_TRACKED", 3)
    limiter = RateLimiter({"ip": (1, 60)})
    for n in range(10):
        limiter.hit("ip", f"198.51.100.{n}")
    assert len(limiter._windows) == 3


async def test_the_guards_limit_through_the_protocol() -> None:
    guards = PublicFormGuards(_settings(public_form_email_limit=1))
    key = guards.email_key("kaia.lindgren@example.com")
    assert await guards.retry_after("email", key) is None
    assert (await guards.retry_after("email", key) or 0) > 0


# --------------------------------------------------------------------------------- ALTCHA
def _solve(challenge: dict[str, Any]) -> int:
    for number in range(challenge["maxnumber"] + 1):
        digest = hashlib.sha256(f"{challenge['salt']}{number}".encode()).hexdigest()
        if digest == challenge["challenge"]:
            return number
    raise AssertionError("no solution")


def _payload(issued: dict[str, Any], /, number: int | None = None, **changes: Any) -> str:
    answer = {"algorithm": issued["algorithm"], "challenge": issued["challenge"],
              "number": _solve(issued) if number is None else number,
              "salt": issued["salt"], "signature": issued["signature"]}
    answer.update(changes)
    return base64.b64encode(json.dumps(answer).encode()).decode()


def _bot(clock: Clock | None = None) -> BotCheck:
    return BotCheck(b"k" * 32, max_number=2000, ttl_seconds=600, clock=clock or Clock())


def test_a_solved_challenge_passes_once() -> None:
    bot = _bot()
    challenge = bot.create_challenge().as_json()
    assert challenge["algorithm"] == "SHA-256" and "?expires=" in challenge["salt"]
    payload = _payload(challenge)
    assert bot.verify(payload)
    assert not bot.verify(payload)  # a second request with the same answer


def test_a_retry_of_the_same_request_may_send_its_answer_again() -> None:
    bot = _bot()
    payload = _payload(bot.create_challenge().as_json())
    assert bot.verify(payload, "key-1")
    assert bot.verify(payload, "key-1")  # the same Idempotency-Key: a retry
    assert not bot.verify(payload, "key-2")  # another request
    assert not bot.verify(payload)


def test_an_expired_challenge_fails() -> None:
    clock = Clock()
    bot = _bot(clock)
    payload = _payload(bot.create_challenge().as_json())
    clock.now += 601
    assert not bot.verify(payload)


@pytest.mark.parametrize("change", [
    {"number": "wrong"},  # a number that doesn't solve it (set below)
    {"signature": "0" * 64},
    {"algorithm": "SHA-1"},
    {"number": True},
    {"number": -1},
    {"challenge": "0" * 64},
])
def test_a_wrong_or_tampered_answer_fails(change: dict[str, Any]) -> None:
    bot = _bot()
    challenge = bot.create_challenge().as_json()
    if change.get("number") == "wrong":
        change = {"number": (_solve(challenge) + 1) % 2001}
    assert not bot.verify(_payload(challenge, **change))


def test_a_challenge_signed_with_another_key_fails() -> None:
    other = BotCheck(b"o" * 32, max_number=2000, ttl_seconds=600, clock=Clock())
    assert not _bot().verify(_payload(other.create_challenge().as_json()))


def test_a_challenge_without_an_expiry_fails() -> None:
    bot = _bot()
    salt = "abc123"
    challenge = hashlib.sha256(f"{salt}7".encode()).hexdigest()
    forged = {"algorithm": "SHA-256", "challenge": challenge, "maxnumber": 2000, "salt": salt,
              "signature": bot._sign(challenge)}
    assert not bot.verify(_payload(forged, number=7))


@pytest.mark.parametrize("payload", ["", "not base64!", base64.b64encode(b"not json").decode(),
                                     base64.b64encode(b"[1, 2]").decode(),
                                     base64.b64encode(b'{"number": 1}').decode(), "A" * 5000])
def test_a_malformed_answer_fails(payload: str) -> None:
    assert not _bot().verify(payload)


async def test_the_guards_create_and_check_challenges() -> None:
    guards = PublicFormGuards(_settings())
    payload = _payload(guards.create_challenge().as_json())
    assert await guards.bot_check_passes(payload, idempotency_key="key-1")
    assert not await guards.bot_check_passes(payload, idempotency_key="key-2")
