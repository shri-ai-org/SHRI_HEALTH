"""How a queued partner message becomes the message the partner receives.

The outbox row holds IDs only (api.enqueue); at send time the adapter asks the module that queued
it to build the partner message from the records those IDs name, in the clinic's session:

    from app.integration.outbound import builds

    @builds("clearinghouse", "270")
    async def build_270(db: AsyncSession, payload: dict[str, Any]) -> dict[str, Any]:
        ...  # the request as contracts/partners/clearinghouse defines it

The worker imports every module before it starts (`load_modules`), so the builders are registered
in its process as they are in the API's.
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


def load_modules() -> list[str]:
    """Imports every module's routes, as the API does, so their builders and callback handlers
    register in this process too."""
    from app.core.routing import module_names  # core's list of module folders

    names = list(module_names())
    for name in names:
        importlib.import_module(f"app.modules.{name}.api")
    return names
