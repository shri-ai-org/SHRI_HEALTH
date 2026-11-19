"""The email sender: one outbox adapter (`email`, partner `notification`; D25) that sends each
message to Brevo or to Mailpit (core/settings/email.py).

    message_id = await enqueue(db, "notification", "portal-invitation",
                               {"invitationId": str(invitation.id)},
                               idempotency_key=f"portal-invitation:{invitation.id}")

The module that queues an email also builds it at send time (outbound.py `@builds`), returning:

    {"to": "patient@example.com", "subject": "…", "text": "…"}

Plain text only. The builder decides the content, and the rule for every email is the clinic's
name and a link, never clinical information (D81).

**Where it goes:**
- `to` on the team allowlist (EMAIL_TEAM_ALLOWLIST), with BREVO_API_KEY set: Brevo, through its
  transactional API (https://api.brevo.com/v3/smtp/email), over the egress proxy.
- Anyone else, including every fictional @example.com patient: Mailpit (MAILPIT_SMTP_HOST), the
  demo's private mail catcher. Without Mailpit the message is dead-lettered (`no-mail-route`):
  it is never sent somewhere real by mistake.
- CI and development have no allowlist, so they only ever use Mailpit. Production refuses both
  settings (no BAA, Q15).

**Never logged:** the key, the address, the subject or the text. Logs and `last_error` hold only
the route, the message ID and a short code (worker.py). Brevo's errors are codes (`http-401`),
never its reply body, which can echo the address.

**Retries:** a timeout, a 429 or a 5xx is retried by the worker with backoff; any other 4xx
(bad key, refused address) is permanent, since retrying can't help.
"""

import asyncio
import logging
import re
import smtplib
from collections.abc import Callable
from dataclasses import dataclass
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from typing import Any, Literal

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.integration.outbound import NoBuilder, build
from app.integration.worker import Delivered, DeliveryError, OutboundMessage

log = logging.getLogger(__name__)

ADAPTER = "email"
PARTNER = "notification"
BREVO_URL = "https://api.brevo.com/v3/smtp/email"
TIMEOUT_SECONDS = 15.0
MAX_SUBJECT = 200
MAX_TEXT = 20_000
# One plain address, no display name or list; at most 254 characters (RFC 5321).
ADDRESS = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")

Route = Literal["brevo", "mailpit"]


@dataclass(frozen=True)
class Email:
    to: str
    subject: str
    text: str


def parse(built: dict[str, Any]) -> Email:
    """The builder's message, checked; a bad one can never be sent (permanent)."""
    to, subject, text = built.get("to"), built.get("subject"), built.get("text")
    if not isinstance(to, str) or len(to) > 254 or not ADDRESS.fullmatch(to):
        raise DeliveryError("bad-address", permanent=True)
    if (not isinstance(subject, str) or not subject or len(subject) > MAX_SUBJECT
            or "\n" in subject or "\r" in subject):
        raise DeliveryError("bad-subject", permanent=True)
    if not isinstance(text, str) or not text or len(text) > MAX_TEXT:
        raise DeliveryError("bad-text", permanent=True)
    return Email(to=to, subject=subject, text=text)


def route(settings: Settings, to: str) -> Route | None:
    """Brevo for the team's own addresses (when its key is set), Mailpit for everyone else, or
    None when there's nowhere safe to send."""
    if to.lower() in settings.team_addresses() and settings.brevo_api_key is not None:
        return "brevo"
    if settings.mailpit_smtp_host:
        return "mailpit"
    return None


SmtpSend = Callable[[str, int, EmailMessage], None]


def _smtp_send(host: str, port: int, message: EmailMessage) -> None:
    with smtplib.SMTP(host, port, timeout=TIMEOUT_SECONDS) as smtp:
        smtp.send_message(message)


class EmailSender:
    """The `email` adapter (see the module docstring)."""

    def __init__(self, settings: Settings, *, client: httpx.AsyncClient | None = None,
                 smtp_send: SmtpSend = _smtp_send) -> None:
        self._settings = settings
        self._client = client or httpx.AsyncClient(timeout=TIMEOUT_SECONDS)
        self._smtp_send = smtp_send

    async def send(self, message: OutboundMessage, session: AsyncSession) -> Delivered:
        try:
            built = await build(session, PARTNER, message.message_type, dict(message.payload))
        except NoBuilder:
            raise DeliveryError("no-builder", permanent=True) from None
        email = parse(built)
        where = route(self._settings, email.to)
        if where is None:
            raise DeliveryError("no-mail-route", permanent=True)
        if where == "brevo":
            control = await self._brevo(email, message)
        else:
            control = await self._mailpit(email, message)
        log.info("Email for outbox message %s sent through %s", message.id, where)
        return Delivered(control_id=control)

    def _from(self) -> tuple[str, str]:
        return self._settings.email_from_name, (self._settings.email_from_address
                                                or "no-reply@shri-health.invalid")

    async def _brevo(self, email: Email, message: OutboundMessage) -> str:
        key = self._settings.brevo_api_key
        if key is None:  # route() checked; kept for the type checker
            raise DeliveryError("no-mail-route", permanent=True)
        name, address = self._from()
        body = {"sender": {"name": name, "email": address}, "to": [{"email": email.to}],
                "subject": email.subject, "textContent": email.text,
                "headers": {"X-Shri-Message-Id": str(message.id)}}
        try:
            response = await self._client.post(
                BREVO_URL, json=body,
                headers={"api-key": key.get_secret_value(), "accept": "application/json"})
        except httpx.TimeoutException:
            raise DeliveryError("timeout") from None
        except httpx.HTTPError:
            raise DeliveryError("connection-failed") from None
        status = response.status_code
        if status in (200, 201, 202):
            try:
                found = response.json().get("messageId")
            except ValueError:  # accepted, with no readable ID: ours stands in
                found = None
            return str(found) if found else str(message.id)
        permanent = 400 <= status < 500 and status not in (408, 429)
        raise DeliveryError(f"http-{status}", permanent=permanent)

    async def _mailpit(self, email: Email, message: OutboundMessage) -> str:
        mail = EmailMessage()
        mail["From"] = formataddr(self._from())
        mail["To"] = email.to
        mail["Subject"] = email.subject
        message_id = make_msgid(idstring=message.id.hex, domain="shri-health.invalid")
        mail["Message-ID"] = message_id
        mail.set_content(email.text)
        try:
            await asyncio.to_thread(self._smtp_send, self._settings.mailpit_smtp_host,
                                    self._settings.mailpit_smtp_port, mail)
        except (OSError, smtplib.SMTPException):
            raise DeliveryError("mailpit-unavailable") from None
        return message_id.strip("<>")

    async def aclose(self) -> None:
        await self._client.aclose()


def email_adapters(settings: Settings) -> dict[str, EmailSender]:
    """The `email` adapter when there is somewhere to send: Brevo for the team, or Mailpit."""
    if not settings.mailpit_smtp_host and not (settings.team_addresses()
                                                and settings.brevo_api_key is not None):
        return {}
    return {ADAPTER: EmailSender(settings)}
