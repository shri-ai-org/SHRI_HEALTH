"""The email sender (integration/mail.py) and its settings (core/settings/email.py): routing
(team address to Brevo, anyone else to Mailpit, nowhere safe: dead-letter), Brevo's answers as
retry or permanent codes, the key read from OpenBao only and never logged. No database, no
network: Brevo is an httpx mock and Mailpit a recorder. The key is a made-up placeholder, never
a real one; addresses are fictional (example.com, example.org)."""

import json
import logging
from email.message import EmailMessage
from typing import Any
from uuid import uuid4

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.integration import outbound
from app.integration.mail import ADAPTER, BREVO_URL, EmailSender, email_adapters, parse, route
from app.integration.worker import DeliveryError, OutboundMessage, adapters

PLACEHOLDER_KEY = "placeholder-not-a-brevo-key"  # noqa: S105 (a test placeholder, never real)
TEAM = "team.member@example.org"
PATIENT = "kaia401.lindgren118@example.com"


def _settings(**overrides: object) -> Settings:
    values: dict[str, object] = {
        "environment": "test", "brevo_api_key": SecretStr(PLACEHOLDER_KEY),
        "email_team_allowlist": f" {TEAM.upper()} , ", "email_from_address": "demo@example.org",
        "mailpit_smtp_host": "mailpit"}
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def _message() -> OutboundMessage:
    return OutboundMessage(
        id=uuid4(), tenant_id=uuid4(), endpoint_id=uuid4(), adapter=ADAPTER,
        message_type="test-email", payload={"invitationId": str(uuid4())},
        idempotency_key=None, ordering_key=None, attempts=1, max_attempts=8,
        correlation_id=None, partner="notification")


@pytest.fixture
def builds_to(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Registers a builder for notification/test-email that sends to the address put in the list."""
    to: list[str] = []

    async def build(db: object, payload: dict[str, Any]) -> dict[str, Any]:
        return {"to": to[0], "subject": "Your Shri Health invitation",
                "text": "Sunrise Clinic invites you: https://example.org/link"}

    monkeypatch.setitem(outbound._BUILDERS, ("notification", "test-email"), build)
    return to


class Recorder:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list[tuple[str, int, EmailMessage]] = []
        self.fail = fail

    def __call__(self, host: str, port: int, message: EmailMessage) -> None:
        if self.fail:
            raise ConnectionRefusedError
        self.sent.append((host, port, message))


def _brevo(status: int, seen: list[httpx.Request], body: object = None) -> httpx.AsyncClient:
    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, json=body if body is not None else {})
    return httpx.AsyncClient(transport=httpx.MockTransport(answer))


# Routing


def test_a_team_address_goes_to_brevo_and_anyone_else_to_mailpit() -> None:
    settings = _settings()
    assert route(settings, TEAM) == "brevo"
    assert route(settings, TEAM.title()) == "brevo"  # case-insensitive
    assert route(settings, PATIENT) == "mailpit"


def test_without_the_key_even_a_team_address_goes_to_mailpit() -> None:
    assert route(_settings(brevo_api_key=None), TEAM) == "mailpit"


def test_ci_and_development_send_everything_to_mailpit() -> None:
    settings = _settings(email_team_allowlist="", brevo_api_key=None)
    assert route(settings, TEAM) == route(settings, PATIENT) == "mailpit"


def test_with_no_mailpit_an_address_off_the_list_has_no_route() -> None:
    assert route(_settings(mailpit_smtp_host=""), PATIENT) is None


def test_the_adapter_exists_only_with_somewhere_to_send() -> None:
    assert ADAPTER in email_adapters(_settings())
    assert email_adapters(_settings(mailpit_smtp_host="", email_team_allowlist="")) == {}
    assert email_adapters(_settings(mailpit_smtp_host="", brevo_api_key=None)) == {}
    assert ADAPTER in adapters(_settings())


# Sending


async def test_a_team_address_is_sent_through_brevo_with_the_key_in_a_header(
        builds_to: list[str]) -> None:
    builds_to.append(TEAM)
    seen: list[httpx.Request] = []
    mailpit = Recorder()
    sender = EmailSender(_settings(), client=_brevo(201, seen, {"messageId": "<b-1@brevo>"}),
                         smtp_send=mailpit)
    message = _message()
    delivered = await sender.send(message, session=None)  # type: ignore[arg-type]
    assert delivered.control_id == "<b-1@brevo>"
    assert mailpit.sent == []
    (request,) = seen
    assert str(request.url) == BREVO_URL
    assert request.headers["api-key"] == PLACEHOLDER_KEY
    body = json.loads(request.content)
    assert body["to"] == [{"email": TEAM}]
    assert body["sender"] == {"name": "Shri Health", "email": "demo@example.org"}
    assert body["subject"] == "Your Shri Health invitation"
    assert body["headers"] == {"X-Shri-Message-Id": str(message.id)}
    assert "htmlContent" not in body


async def test_a_patient_address_goes_to_mailpit_never_to_brevo(builds_to: list[str]) -> None:
    builds_to.append(PATIENT)
    seen: list[httpx.Request] = []
    mailpit = Recorder()
    sender = EmailSender(_settings(), client=_brevo(201, seen), smtp_send=mailpit)
    message = _message()
    delivered = await sender.send(message, session=None)  # type: ignore[arg-type]
    assert seen == []
    ((host, port, mail),) = mailpit.sent
    assert (host, port) == ("mailpit", 1025)
    assert (mail["To"], mail["Subject"]) == (PATIENT, "Your Shri Health invitation")
    assert mail["From"] == "Shri Health <demo@example.org>"
    assert message.id.hex in mail["Message-ID"]
    assert delivered.control_id and message.id.hex in delivered.control_id


async def test_no_route_is_a_permanent_failure(builds_to: list[str]) -> None:
    builds_to.append(PATIENT)
    sender = EmailSender(_settings(mailpit_smtp_host=""), client=_brevo(201, []))
    with pytest.raises(DeliveryError) as error:
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    assert (error.value.code, error.value.permanent) == ("no-mail-route", True)


@pytest.mark.parametrize(("status", "code", "permanent"), [
    (500, "http-500", False), (503, "http-503", False), (429, "http-429", False),
    (408, "http-408", False), (400, "http-400", True), (401, "http-401", True),
    (403, "http-403", True)])
async def test_brevo_failures_are_retried_or_given_up_by_status(
        builds_to: list[str], status: int, code: str, permanent: bool) -> None:
    builds_to.append(TEAM)
    sender = EmailSender(_settings(), client=_brevo(status, [], {"message": TEAM}))
    with pytest.raises(DeliveryError) as error:
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    assert (error.value.code, error.value.permanent) == (code, permanent)


async def test_a_brevo_timeout_is_retried(builds_to: list[str]) -> None:
    builds_to.append(TEAM)

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    sender = EmailSender(_settings(), client=httpx.AsyncClient(transport=httpx.MockTransport(slow)))
    with pytest.raises(DeliveryError) as error:
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    assert (error.value.code, error.value.permanent) == ("timeout", False)


async def test_mailpit_down_is_retried(builds_to: list[str]) -> None:
    builds_to.append(PATIENT)
    sender = EmailSender(_settings(), client=_brevo(201, []), smtp_send=Recorder(fail=True))
    with pytest.raises(DeliveryError) as error:
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    assert (error.value.code, error.value.permanent) == ("mailpit-unavailable", False)


async def test_a_message_no_module_builds_is_a_permanent_failure() -> None:
    sender = EmailSender(_settings(), client=_brevo(201, []))
    with pytest.raises(DeliveryError) as error:
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    assert (error.value.code, error.value.permanent) == ("no-builder", True)


@pytest.mark.parametrize(("built", "code"), [
    ({"to": "two@example.com, three@example.com", "subject": "s", "text": "t"}, "bad-address"),
    ({"to": "Name <one@example.com>", "subject": "s", "text": "t"}, "bad-address"),
    ({"to": "one@example.com\r\nBcc: x@example.com", "subject": "s", "text": "t"}, "bad-address"),
    ({"to": PATIENT, "subject": "a\r\nBcc: x@example.com", "text": "t"}, "bad-subject"),
    ({"to": PATIENT, "subject": "", "text": "t"}, "bad-subject"),
    ({"to": PATIENT, "subject": "s", "text": ""}, "bad-text"),
    ({"subject": "s", "text": "t"}, "bad-address")])
def test_a_badly_built_email_is_never_sent(built: dict[str, Any], code: str) -> None:
    with pytest.raises(DeliveryError) as error:
        parse(built)
    assert (error.value.code, error.value.permanent) == (code, True)


async def test_nothing_about_the_email_or_the_key_is_logged(
        builds_to: list[str], caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.DEBUG)
    seen: list[httpx.Request] = []
    sender = EmailSender(_settings(), client=_brevo(201, seen, {"messageId": "m"}),
                         smtp_send=Recorder())
    for to in (TEAM, PATIENT):
        builds_to[:] = [to]
        await sender.send(_message(), session=None)  # type: ignore[arg-type]
    builds_to[:] = [TEAM]
    failing = EmailSender(_settings(), client=_brevo(401, [], {"message": TEAM}))
    with pytest.raises(DeliveryError):
        await failing.send(_message(), session=None)  # type: ignore[arg-type]
    for private in (PLACEHOLDER_KEY, TEAM, PATIENT, "invitation", "Sunrise Clinic"):
        assert private.lower() not in caplog.text.lower()
    # The key isn't in the settings' repr or dump either (SecretStr); the allowlist is plain
    # configuration and may be.
    assert PLACEHOLDER_KEY not in repr(_settings()) + str(_settings().model_dump())


# Settings


def test_the_key_is_never_read_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BREVO_API_KEY", PLACEHOLDER_KEY)
    monkeypatch.setenv("CLAUDE_API_KEY", "placeholder-other")  # others still come from the env
    monkeypatch.delenv("OPENBAO_ADDR", raising=False)
    settings = Settings(environment="test")
    assert settings.brevo_api_key is None
    assert settings.claude_api_key is not None


def test_the_key_is_read_from_openbao(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core import settings as module

    def secret(self: object) -> dict[str, Any]:
        return {"brevo_api_key": PLACEHOLDER_KEY}

    monkeypatch.setattr(module.OpenBaoSource, "__call__", secret)
    loaded = Settings(environment="test")
    assert loaded.brevo_api_key is not None
    assert loaded.brevo_api_key.get_secret_value() == PLACEHOLDER_KEY


@pytest.mark.parametrize("overrides", [
    {"email_team_allowlist": TEAM, "email_from_address": "demo@example.org"},
    {"mailpit_smtp_host": "mailpit"}])
def test_production_never_routes_email(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError, match="never allowed in production"):
        Settings(environment="production", **overrides)  # type: ignore[arg-type]


def test_an_allowlist_needs_a_sender_address() -> None:
    with pytest.raises(ValidationError, match="EMAIL_FROM_ADDRESS"):
        Settings(environment="test", email_team_allowlist=TEAM)
