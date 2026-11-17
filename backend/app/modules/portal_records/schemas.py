"""Response shapes for the portal's lab results (portal.yaml `PortalLabResult*`). Field names are
the contract's camelCase."""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CodedValue(Out):
    system: str | None = None
    code: str | None = None
    display: str | None = None


class Quantity(Out):
    value: float
    unit: Annotated[str, Field(max_length=32)]


class ReferenceRange(Out):
    low: float | None = None
    high: float | None = None
    text: Annotated[str, Field(max_length=200)] | None = None


class LabObservation(Out):
    code: CodedValue
    short_name: Annotated[str, Field(max_length=100)] | None = None
    value: Quantity | None = None
    text: Annotated[str, Field(max_length=2000)] | None = None
    reference_range: ReferenceRange | None = None
    interpretation: Literal["H", "L", "N", "A"] | None = None


class LabResult(Out):
    id: UUID
    release_status: Literal["available", "held"]
    code: CodedValue | None = None
    short_name: Annotated[str, Field(max_length=100)] | None = None
    status: Literal["final", "amended", "corrected", "appended"] | None = None
    effective_at: datetime | None = None
    issued_at: datetime | None = None
    results: Annotated[list[LabObservation], Field(max_length=100)] | None = None
    conclusion: Annotated[str, Field(max_length=4000)] | None = None


class LabResultList(Out):
    items: Annotated[list[LabResult], Field(max_length=100)]
    next_cursor: str | None = None
