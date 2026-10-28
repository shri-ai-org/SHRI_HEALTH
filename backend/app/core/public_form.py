"""The guards of a public form (D96: online pre-registration), which has no account and no session.

    guards: PublicFormGuards = Depends(public_form_guards)

- **`Origin`:** only the portal host, exactly (scheme, host and port), else 403
  `csrf-check-failed`. deps.public_db checks it too, so a route can't forget it.
- **Rate limits** per IP and per email. The email's key is an HMAC with the server's secret, so
  the limiter never holds an address, and nothing here logs one.
- **The bot check** is ALTCHA (MIT, self-hosted), verified here with the standard library only:
  the server signs a challenge (`create_challenge()`), the browser finds the number by proof of
  work, and the server checks the answer, its signature and its expiry. An answer is good for
  one request: a retry of that request (the same Idempotency-Key) may send it again, another
  request may not.

Fails closed: without PORTAL_ORIGIN or PUBLIC_FORM_SECRET, public forms answer 503.

**One process only, for now.** The limiter's counters and the used bot answers live in this
process's memory: with several API workers each counts on its own. Nginx's per-IP limit on the
public path is shared by all workers (infra/nginx/nginx.conf); a shared store comes before more
than one API process serves public forms.
"""

import base64
import binascii
import hashlib
import hmac
import json
import secrets
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, FastAPI, Request, Response

from app.core.config import Settings
from app.core.errors import AppError, Forbidden, ServiceUnavailable

ALGORITHM = "SHA-256"
MIN_SECRET_LENGTH = 32
MAX_TRACKED = 100_000  # counters and used answers kept at most; the oldest go first
STATE = "public_form_guards"  # app.state key: one set of guards per app


def require_portal_origin(request: Request) -> None:
    """403 `csrf-check-failed` unless `Origin` is exactly the portal host; 503 if none is set."""
    settings: Settings = request.app.state.settings
    if not settings.portal_origin:
        raise ServiceUnavailable("Public forms are not available")
    if not origin_matches(request.headers.get("origin"), settings.portal_origin):
        raise Forbidden("Requests are accepted only from the portal", code="csrf-check-failed")


def origin_matches(origin: str | None, portal_origin: str) -> bool:
    """Exact, case-insensitive match of scheme, host and port. A missing Origin, "null", a path or
    a trailing slash never match."""
    if not origin:
        return False
    return hmac.compare_digest(origin.strip().lower().encode(),
                               portal_origin.strip().lower().rstrip("/").encode())


class RateLimiter:
    """Fixed windows per (scope, key), in this process's memory (see the module docstring)."""

    def __init__(self, limits: dict[str, tuple[int, int]],
                 clock: Callable[[], float] = time.monotonic) -> None:
        self._limits = limits  # scope -> (requests, window seconds)
        self._clock = clock
        self._windows: OrderedDict[tuple[str, str], tuple[float, int]] = OrderedDict()

    def hit(self, scope: str, key: str) -> int | None:
        """Counts one request; None within the limit, else the seconds until the window ends."""
        if scope not in self._limits:
            raise ValueError(f"Unknown rate-limit scope {scope!r}")
        limit, window = self._limits[scope]
        now = self._clock()
        started, count = self._windows.get((scope, key), (now, 0))
        if now - started >= window:
            started, count = now, 0
        count += 1
        self._windows[(scope, key)] = (started, count)
        self._windows.move_to_end((scope, key))
        while len(self._windows) > MAX_TRACKED:
            self._windows.popitem(last=False)
        if count > limit:
            return max(1, int(started + window - now + 0.999))
        return None


@dataclass(frozen=True)
class Challenge:
    algorithm: str
    challenge: str
    maxnumber: int
    salt: str
    signature: str

    def as_json(self) -> dict[str, Any]:
        """What the ALTCHA widget reads from its challenge URL."""
        return {"algorithm": self.algorithm, "challenge": self.challenge,
                "maxnumber": self.maxnumber, "salt": self.salt, "signature": self.signature}


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class BotCheck:
    """ALTCHA challenges signed with the server's key, and their answers verified once."""

    def __init__(self, key: bytes, max_number: int, ttl_seconds: int,
                 clock: Callable[[], float] = time.time) -> None:
        self._key = key
        self._max_number = max_number
        self._ttl = ttl_seconds
        self._clock = clock
        self._used: OrderedDict[str, tuple[float, str | None]] = OrderedDict()  # signature ->

    def _sign(self, challenge: str) -> str:
        return hmac.new(self._key, challenge.encode(), hashlib.sha256).hexdigest()

    def create_challenge(self) -> Challenge:
        expires = int(self._clock()) + self._ttl
        salt = f"{secrets.token_hex(12)}?expires={expires}"
        number = secrets.randbelow(self._max_number + 1)
        challenge = _sha256_hex(f"{salt}{number}")
        return Challenge(ALGORITHM, challenge, self._max_number, salt, self._sign(challenge))

    def verify(self, payload: str, idempotency_key: str | None = None) -> bool:
        """True for a correct, signed, unexpired answer not yet used by another request."""
        answer = _decode(payload)
        if answer is None:
            return False
        algorithm, challenge, number, salt, signature = answer
        if algorithm != ALGORITHM or not 0 <= number <= self._max_number:
            return False
        if not hmac.compare_digest(_sha256_hex(f"{salt}{number}"), challenge):
            return False
        if not hmac.compare_digest(self._sign(challenge), signature):
            return False
        expires = _expiry(salt)
        now = self._clock()
        if expires is None or expires <= now:
            return False
        self._forget_expired(now)
        used = self._used.get(signature)
        if used is not None:
            # The same request retried may send its answer again; any other request may not.
            return idempotency_key is not None and used[1] == idempotency_key
        self._used[signature] = (expires, idempotency_key)
        while len(self._used) > MAX_TRACKED:
            self._used.popitem(last=False)
        return True

    def _forget_expired(self, now: float) -> None:
        for signature, (expires, _) in list(self._used.items()):
            if expires > now:
                break  # roughly in expiry order; an expired answer is refused before this anyway
            del self._used[signature]


def _decode(payload: str) -> tuple[str, str, int, str, str] | None:
    """The widget's answer: base64 of a JSON object (algorithm, challenge, number, salt,
    signature). None if it isn't one."""
    if not payload or len(payload) > 4096:
        return None
    try:
        data = json.loads(base64.b64decode(payload, validate=True))
    except (binascii.Error, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    fields = (data.get("algorithm"), data.get("challenge"), data.get("number"),
              data.get("salt"), data.get("signature"))
    algorithm, challenge, number, salt, signature = fields
    if not (isinstance(algorithm, str) and isinstance(challenge, str) and isinstance(salt, str)
            and isinstance(signature, str) and isinstance(number, int)
            and not isinstance(number, bool)):
        return None
    return algorithm, challenge, number, salt, signature


def _expiry(salt: str) -> int | None:
    _, _, query = salt.partition("?")
    values = parse_qs(query).get("expires")
    if not values or not values[0].isdigit():
        return None  # a challenge without an expiry is never accepted
    return int(values[0])


class PublicFormGuards:
    """What a public form's route uses (the patients module's `PublicFormGuards` protocol)."""

    def __init__(self, settings: Settings) -> None:
        if not settings.portal_origin or settings.public_form_secret is None:
            raise ValueError("PORTAL_ORIGIN and PUBLIC_FORM_SECRET are needed for public forms")
        secret = settings.public_form_secret.get_secret_value()
        if len(secret) < MIN_SECRET_LENGTH:
            raise ValueError(f"PUBLIC_FORM_SECRET must be at least {MIN_SECRET_LENGTH} characters")
        # Two keys from one secret, so a bot-check signature is never an email key or back.
        self._email_key = hmac.new(secret.encode(), b"shri-public-form:email", hashlib.sha256)
        bot_key = hmac.new(secret.encode(), b"shri-public-form:altcha", hashlib.sha256).digest()
        self._portal_origin = settings.portal_origin
        self.limiter = RateLimiter({
            "ip": (settings.public_form_ip_limit, settings.public_form_ip_window_seconds),
            "email": (settings.public_form_email_limit, settings.public_form_email_window_seconds),
            "challenge": (settings.bot_challenge_ip_limit, 3600),
        })
        self.bot_check = BotCheck(bot_key, settings.bot_check_max_number,
                                  settings.bot_check_ttl_seconds)

    def origin_allowed(self, origin: str | None) -> bool:
        return origin_matches(origin, self._portal_origin)

    def email_key(self, email: str) -> str:
        """The rate limit's key for an already-normalized address: HMAC-SHA-256, hex."""
        mac = self._email_key.copy()
        mac.update(email.encode())
        return mac.hexdigest()

    async def retry_after(self, scope: str, key: str) -> int | None:
        return self.limiter.hit(scope, key)

    async def bot_check_passes(self, payload: str, idempotency_key: str | None = None) -> bool:
        return self.bot_check.verify(payload, idempotency_key)

    def create_challenge(self) -> Challenge:
        return self.bot_check.create_challenge()


def public_form_guards(request: Request) -> PublicFormGuards:
    """FastAPI dependency: the app's guards (one per app, so counters and used answers are
    shared by its requests); 503 if public forms aren't configured."""
    guards: PublicFormGuards | None = getattr(request.app.state, STATE, None)
    if guards is None:
        raise ServiceUnavailable("Public forms are not available")
    return guards


# ------------------------------------------------------------------------ the challenge route
class TooManyChallenges(AppError):
    default_code = "rate-limited"


CHALLENGE_OPERATION = "getBotChallenge"
router = APIRouter(tags=["portal"])


@router.get("/portal/bot-challenge", operation_id=CHALLENGE_OPERATION)
async def get_bot_challenge(
    request: Request, response: Response,
    guards: PublicFormGuards = Depends(public_form_guards),
) -> dict[str, Any]:
    """A fresh signed ALTCHA challenge (#136, D96): public, no session and no practice code, not
    audited. Per IP it has its own budget, so fetching one never uses up the form's; nginx limits
    the path too. Each solved challenge is accepted once (BotCheck.verify)."""
    client = request.client.host if request.client else "unknown"
    wait = await guards.retry_after("challenge", client)
    if wait is not None:
        raise TooManyChallenges("Too many challenges; try again later",
                                headers={"Retry-After": str(wait)})
    response.headers["Cache-Control"] = "no-store"
    return guards.create_challenge().as_json()


def include_routes(app: FastAPI, api_prefix: str) -> None:
    """Mounts the challenge route once the contract has it (#136). create_app() refuses a route
    the operations map doesn't have, so until then it stays out and the API still starts."""
    from app.core.operations import OperationsMapError, load_operations

    try:
        known = load_operations()
    except OperationsMapError:
        return
    if CHALLENGE_OPERATION in known:
        app.include_router(router, prefix=api_prefix)
