"""The two pieces PR-1 needs from other owners, behind one seam each so the endpoints never change:

- the restricted-chart check, core's ``ensure_chart_access(db, user, patient_id)`` (Thulasi, #83;
  D37, SECURITY_MODEL §5.2), which raises ``break-glass-required``;
- the FHIR write helpers, ``app.db.fhir_store.SqlFhirStore`` (Anand, #88), which implement
  ``store.FhirStore``.

Until each lands on main, its dependency **fails closed** with 503: no patient endpoint serves or
writes a chart without the check and the helpers (batch 1 plan, decision 1). Tests replace both
with ``app.dependency_overrides``.

The helpers have their own copies of the interface's types: the same names and fields as
``store.py`` (the agreed interface, with the renames on #13), but their own ``UNSET`` sentinel and
exception classes. ``_Helpers`` passes the module's own types in and raises ``store``'s exceptions
out, so a field left unset is never mistaken for a value.
"""

from __future__ import annotations

import dataclasses
import importlib
from collections.abc import Awaitable, Callable
from types import ModuleType
from typing import Any, cast
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import ServiceUnavailable

from . import store
from .store import FhirStore

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[None]]


def _module(name: str, what: str) -> ModuleType:
    try:
        return importlib.import_module(name)
    except ModuleNotFoundError as missing:
        raise ServiceUnavailable(f"{what} is not available yet") from missing


def _attribute(module: ModuleType, attribute: str, what: str) -> object:
    found: object = module.__dict__.get(attribute)
    if found is None:
        raise ServiceUnavailable(f"{what} is not available yet")
    return found


def chart_check() -> ChartCheck:
    """FastAPI dependency: the restricted-chart check to run before any chart is read or written."""
    what = "The restricted-chart check"
    check = _attribute(_module("app.core.access", what), "ensure_chart_access", what)
    return cast(ChartCheck, check)


class _Helpers:
    """``SqlFhirStore`` called with its module's own types; its exceptions come back as
    ``store``'s, which the service catches."""

    def __init__(self, module: ModuleType) -> None:
        self._module = module
        store_class = _attribute(module, "SqlFhirStore", "The FHIR write helpers")
        self._store = cast(Callable[[], Any], store_class)()
        self._errors: dict[type[BaseException], Callable[[Any], Exception]] = {
            module.StaleVersion: lambda e: store.StaleVersion(e.current_version),
            module.ResourceNotFound: lambda e: store.ResourceNotFound(),
            module.InvalidTransition: lambda e: store.InvalidTransition(e.current_state),
            module.InvalidInput: lambda e: store.InvalidInput(str(e)),
        }

    def _theirs(self, value: Any) -> Any:
        if value is store.UNSET:
            return self._module.UNSET
        if dataclasses.is_dataclass(value) and not isinstance(value, type):
            target = getattr(self._module, type(value).__name__)
            return target(**{f.name: self._theirs(getattr(value, f.name))
                             for f in dataclasses.fields(value)})
        if isinstance(value, tuple):
            return tuple(self._theirs(v) for v in value)
        return value

    def __getattr__(self, name: str) -> Callable[..., Awaitable[Any]]:
        method = getattr(self._store, name)

        async def call(*args: Any, **kwargs: Any) -> Any:
            try:
                return await method(*(self._theirs(a) for a in args),
                                    **{k: self._theirs(v) for k, v in kwargs.items()})
            except tuple(self._errors) as error:
                raise self._errors[type(error)](error) from error

        return call


def fhir_store() -> FhirStore:
    """FastAPI dependency: the FHIR write helpers."""
    return cast(FhirStore, _Helpers(_module("app.db.fhir_store", "The FHIR write helpers")))
