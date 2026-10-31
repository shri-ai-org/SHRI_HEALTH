"""Response shapes for the patient portal's visit summaries (contracts/openapi/modules/portal.yaml,
``PortalVisitSummary``, ``PortalVisitSummaryList``; B8a, D89). Field names are the contract's
camelCase (aliases)."""

from __future__ import annotations

import datetime as dt
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

#: ``available``, or ``held`` by a clinician (D86, D90): listed without its content.
ReleaseStatus = Literal["available", "held"]


class Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PortalVisitSummary(Out):
    id: UUID
    visit_date: dt.date
    provider_display_name: str | None = None
    facility_name: str | None = None
    release_status: ReleaseStatus
    available_at: dt.datetime | None = None


class PortalVisitSummaryList(Out):
    items: list[PortalVisitSummary]
    next_cursor: str | None = None
