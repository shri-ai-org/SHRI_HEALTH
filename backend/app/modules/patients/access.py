"""The pieces PR-1 uses from other owners, one FastAPI dependency each, so tests can replace them
with ``app.dependency_overrides``:

- the restricted-chart check, core's ``ensure_chart_access(db, user, patient_id)`` (Thulasi, #83;
  D37, SECURITY_MODEL §5.2), which raises ``break-glass-required``;
- the FHIR write helpers, ``app.db.fhir_store.SqlFhirStore`` (Anand, #88), which implement
  ``store.FhirStore``;
- the audit hooks, core's ``audit_patients`` and ``audit_detail`` (Thulasi, #79), which name the
  patients of an operation whose ``x-audit.patient`` is ``result`` or ``body:/…``, and the reason
  where x-audit alone doesn't give it;
- the portal invitations, core's ``issue_invitation`` and ``revoke_invitation`` (Thulasi, #148;
  ADR-0013 §3), which make the code, store only its HMAC and revoke; this module never sees the
  key.

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
from app.core import portal_sign_in as core_portal
from app.core.config import Settings
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
            known = {f.name for f in dataclasses.fields(target)}
            fields: dict[str, Any] = {}
            for f in dataclasses.fields(value):
                given = getattr(value, f.name)
                if f.name in known:
                    fields[f.name] = self._theirs(given)
                elif given is not store.UNSET:
                    # A field our interface has and the helpers don't yet
                    # (CoverageChanges.payer_id): refused, never dropped silently.
                    name = f"{type(value).__name__}.{f.name}"
                    raise store.InvalidInput(f"{name} is not supported yet")
            return target(**fields)
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


@dataclass(frozen=True)
class PortalInvitations:
    """``issue(db, patient_id, user_id)``: revoke the patient's open invitation and make a new
    one, returning its code once (409 while the chart has a live account). ``revoke(db,
    patient_id, invitation_id, user_id)``: 404 for an invitation that isn't the patient's, 409
    for a used one, nothing for one already revoked or expired. Both run in the request's
    session and never commit."""

    issue: Callable[[AsyncSession, UUID, UUID], Awaitable[core_portal.IssuedInvitation]]
    revoke: Callable[[AsyncSession, UUID, UUID, UUID], Awaitable[None]]


def portal_invitations(request: Request) -> PortalInvitations:
    """FastAPI dependency: core's invitation functions, with the app's settings (the HMAC key)."""
    settings: Settings = request.app.state.settings

    async def issue(db: AsyncSession, patient_id: UUID, user_id: UUID
                    ) -> core_portal.IssuedInvitation:
        return await core_portal.issue_invitation(db, settings, patient_id, user_id)

    return PortalInvitations(issue=issue, revoke=core_portal.revoke_invitation)
