"""The pieces PR-1 uses from other owners, one FastAPI dependency each, so tests can replace them
with ``app.dependency_overrides``:

- the restricted-chart check, core's ``ensure_chart_access(db, user, patient_id)`` (Thulasi, #83;
  D37, SECURITY_MODEL §5.2), which raises ``break-glass-required``;
- the FHIR write helpers, ``app.db.fhir_store.SqlFhirStore`` (Anand, #88), which implement
  ``store.FhirStore``;
- the audit hooks, core's ``audit_patients`` and ``audit_detail`` (Thulasi, #79), which name the
  patients of an operation whose ``x-audit.patient`` is ``result`` or ``body:/…``, and the reason
  where x-audit alone doesn't give it.

The helpers have their own copies of the interface's types: the same names and fields as
``store.py`` (the agreed interface, with the renames on #13), but their own ``UNSET`` sentinel and
exception classes. ``_Helpers`` passes the module's own types in and raises ``store``'s exceptions
out, so a field left unset is never mistaken for a value.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from types import ModuleType
from typing import Any, cast
from uuid import UUID

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core.deps import CurrentUser
from app.db import fhir_store as helpers

from . import store
from .store import FhirStore

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[object]]


def chart_check() -> ChartCheck:
    """FastAPI dependency: the restricted-chart check to run before any chart is read or written."""
    return core_access.ensure_chart_access


class _Helpers:
    """``SqlFhirStore`` called with its module's own types; its exceptions come back as
    ``store``'s, which the service catches."""

    def __init__(self, module: ModuleType) -> None:
        self._module = module
        self._store = module.SqlFhirStore()
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
    return cast(FhirStore, _Helpers(helpers))


@dataclass(frozen=True)
class AuditHooks:
    """``patients(request, ids)``: the patients an operation returned or touched. ``detail(request,
    action, reason)``: the action and reason where x-audit alone doesn't say it (a restriction's
    reason, a duplicate override's reason)."""

    patients: Callable[[Request, Iterable[UUID]], None]
    detail: Callable[[Request, str, str | None], None]


def audit_hooks() -> AuditHooks:
    """FastAPI dependency: core's audit hooks."""
    return AuditHooks(
        patients=core_audit.audit_patients,
        detail=lambda request, action, reason: core_audit.audit_detail(
            request, action=action, reason=reason))
