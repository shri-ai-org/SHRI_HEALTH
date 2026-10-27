"""The two pieces PR-1 needs from other owners, behind one seam each so the endpoints never change:

- the restricted-chart check, core's ``ensure_chart_access(db, user, patient_id)`` (Thulasi, #83;
  D37, SECURITY_MODEL §5.2), which raises ``break-glass-required``;
- the FHIR write helpers, ``app.db.fhir_store.SqlFhirStore`` (Anand, #88), which implement
  ``store.FhirStore``.

Until each lands on main, its dependency **fails closed** with 503: no patient endpoint serves or
writes a chart without the check and the helpers (batch 1 plan, decision 1). Tests replace both
with ``app.dependency_overrides``.
"""

from __future__ import annotations

import importlib
from collections.abc import Awaitable, Callable
from typing import cast
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import ServiceUnavailable

from .store import FhirStore

ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[None]]


def _load(module_name: str, attribute: str, what: str) -> object:
    try:
        module = importlib.import_module(module_name)
    except ModuleNotFoundError as missing:
        raise ServiceUnavailable(f"{what} is not available yet") from missing
    found: object = module.__dict__.get(attribute)
    if found is None:
        raise ServiceUnavailable(f"{what} is not available yet")
    return found


def chart_check() -> ChartCheck:
    """FastAPI dependency: the restricted-chart check to run before any chart is read or written."""
    return cast(ChartCheck, _load("app.core.access", "ensure_chart_access",
                                  "The restricted-chart check"))


def fhir_store() -> FhirStore:
    """FastAPI dependency: the FHIR write helpers."""
    store_class = cast(Callable[[], FhirStore],
                       _load("app.db.fhir_store", "SqlFhirStore", "The FHIR write helpers"))
    return store_class()
