"""Pydantic shapes for the orders module's reads (contracts/openapi/modules/orders.yaml)."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from ..encounters.schemas import CodeableConcept, Out, Quantity

ReportStatus = Literal["final", "amended", "corrected", "appended"]
ObservationStatus = Literal["final", "amended", "corrected"]
Interpretation = Literal["H", "L", "N", "A", "HH", "LL"]


class ReferenceRange(Out):
    low: Quantity | None = None
    high: Quantity | None = None
    text: str | None = None


class LabObservation(Out):
    id: UUID
    code: CodeableConcept
    status: ObservationStatus
    value: Quantity | None = None
    value_text: str | None = None
    reference_range: ReferenceRange | None = None
    interpretation: Interpretation | None = None


class LabResult(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    code: CodeableConcept
    status: ReportStatus
    collected_at: datetime | None = None
    issued_at: datetime | None = None
    performer: str | None = None
    conclusion: str | None = None
    observations: Annotated[list[LabObservation], Field(max_length=200)] = []


class LabResultList(Out):
    items: list[LabResult]
    next_cursor: str | None = None


class ImagingReport(Out):
    id: UUID
    patient_id: UUID
    encounter_id: UUID | None = None
    code: CodeableConcept
    status: ReportStatus
    studied_at: datetime | None = None
    issued_at: datetime | None = None
    performer: str | None = None
    impression: str | None = None
    text: str | None = None


class ImagingReportList(Out):
    items: list[ImagingReport]
    next_cursor: str | None = None
