"""Pydantic shapes for the patient portal's own history reads
(contracts/openapi/modules/portal.yaml: PortalProblem, PortalAllergy, PortalVital, their lists)."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from ..encounters.schemas import Out, Quantity

VitalType = Literal["blood-pressure", "heart-rate", "respiratory-rate", "body-temperature",
                    "body-weight", "body-height", "bmi", "oxygen-saturation", "head-circumference"]


class PortalProblem(Out):
    id: UUID
    release_status: Literal["available", "held"]
    display: str | None = None
    clinical_status: Literal["active", "recurrence", "relapse", "inactive", "remission",
                             "resolved"] | None = None
    onset_date: str | None = None
    abatement_date: str | None = None
    recorded_at: datetime | None = None


class PortalProblemList(Out):
    items: Annotated[list[PortalProblem], Field(max_length=100)]
    next_cursor: str | None = None


class PortalReaction(Out):
    manifestations: Annotated[list[str], Field(max_length=10)]
    severity: Literal["mild", "moderate", "severe"] | None = None


class PortalAllergy(Out):
    id: UUID
    display: str
    clinical_status: Literal["active", "inactive", "resolved"]
    criticality: Literal["low", "high", "unable-to-assess"] | None = None
    reactions: Annotated[list[PortalReaction], Field(max_length=10)] = []
    recorded_at: datetime | None = None


class PortalAllergyList(Out):
    items: Annotated[list[PortalAllergy], Field(max_length=100)]
    next_cursor: str | None = None


class PortalVital(Out):
    id: UUID
    type: VitalType
    value: Quantity | None = None
    systolic: Quantity | None = None
    diastolic: Quantity | None = None
    effective_at: datetime


class PortalVitalList(Out):
    items: Annotated[list[PortalVital], Field(max_length=100)]
    next_cursor: str | None = None
