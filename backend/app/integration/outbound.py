"""How a queued partner message becomes the message the partner receives.

The outbox row holds IDs only (api.enqueue); at send time the adapter asks the module that queued
it to build the partner message from the records those IDs name, in the clinic's session:

    from app.integration.outbound import builds

    @builds("clearinghouse", "270")
    async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        ...  # the request as contracts/partners/clearinghouse defines it

A message that can never be built (the record is gone, a required field is missing) should make the
builder raise `DeliveryError(code, permanent=True)` (app/integration/worker.py): it is
dead-lettered with that code at once instead of being retried. Anything else it raises is retried
as `internal-error`.

Modules can also hear how a send ended, in the worker's clinic session (each in a savepoint, so a
failing hook never undoes the outcome the worker recorded):

    @on_sent("erx", "NewRx")              # (db, payload, control_id): e.g. the NewRx is `sent`
    @on_dead_letter("clearinghouse", "270")  # (db, payload, error_code): e.g. fail the check

The send, the builder included, runs in a savepoint: a builder whose SQL fails is recorded as a
failed attempt (`internal-error`) and the rest of the round goes on.

**Not covered:** a message the claim gives up on in SQL (`admin.claim_outbound_messages`
dead-letters one still `sending` after its last attempt, because a worker died mid-send) gets no
`on_dead_letter` call. A module that must end its own state should also time it out (an
operation's time limit does, `core/long_running.py`).

The worker imports every module before it starts (`load_modules`), so the builders and hooks are
registered in its process as they are in the API's. Builders and hooks run as `shri_integration`:
whatever they read or write needs that role's grants (D23, Anand).
"""

import importlib
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.integration.api import PARTNERS

Builder = Callable[[AsyncSession, dict[str, Any]], Awaitable[dict[str, Any]]]
_BUILDERS: dict[tuple[str, str], Builder] = {}


class NoBuilder(LookupError):
    """No module builds this partner message type."""


def builds(partner: str, message_type: str) -> Callable[[Builder], Builder]:
    if partner not in PARTNERS:
        raise ValueError(f"partner {partner!r} is not one of {sorted(PARTNERS)} (D25)")

    def register(builder: Builder) -> Builder:
        if (partner, message_type) in _BUILDERS:
            raise ValueError(f"{partner} {message_type} already has a builder")
        _BUILDERS[(partner, message_type)] = builder
        return builder

    return register


async def build(db: AsyncSession, partner: str, message_type: str,
                payload: dict[str, Any]) -> dict[str, Any]:
    builder = _BUILDERS.get((partner, message_type))
    if builder is None:
        raise NoBuilder(f"{partner} {message_type}")
    return await builder(db, payload)


Hook = Callable[[AsyncSession, dict[str, Any], str], Awaitable[object]]
_HOOKS: dict[tuple[str, str, str], Hook] = {}


def _hook(event: str, partner: str, message_type: str) -> Callable[[Hook], Hook]:
    if partner not in PARTNERS:
        raise ValueError(f"partner {partner!r} is not one of {sorted(PARTNERS)} (D25)")

    def register(hook: Hook) -> Hook:
        if (event, partner, message_type) in _HOOKS:
            raise ValueError(f"{partner} {message_type} already has an {event} hook")
        _HOOKS[(event, partner, message_type)] = hook
        return hook

    return register


def on_sent(partner: str, message_type: str) -> Callable[[Hook], Hook]:
    """Called after the partner took the message: (db, payload, control_id)."""
    return _hook("sent", partner, message_type)


def on_dead_letter(partner: str, message_type: str) -> Callable[[Hook], Hook]:
    """Called once the message is given up on: (db, payload, error_code)."""
    return _hook("dead-letter", partner, message_type)


def hook(event: str, partner: str, message_type: str) -> Hook | None:
    return _HOOKS.get((event, partner, message_type))


def load_modules() -> list[str]:
    """Imports every module's routes, as the API does, so their builders and callback handlers
    register in this process too."""
    from app.core.routing import module_names  # core's list of module folders

    names = list(module_names())
    for name in names:
        importlib.import_module(f"app.modules.{name}.api")
    return names
