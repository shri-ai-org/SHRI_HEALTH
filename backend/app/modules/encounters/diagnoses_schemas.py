"""Request shapes for the encounter's diagnoses (contracts/openapi/modules/encounters.yaml:
DiagnosisCreate, DiagnosisRemove). The response is ``schemas.EncounterDiagnosis``."""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from .schemas import Closed, Coding

PARTIAL_DATE = r"^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$"


class DiagnosisCreate(Closed):
    code: Coding
    additional_codings: Annotated[list[Coding], Field(max_length=5)] | None = None
    rank: Annotated[int, Field(ge=1, le=12)] | None = None
    verification_status: Literal["confirmed", "provisional", "differential"] = "confirmed"
    onset_date: Annotated[str, StringConstraints(pattern=PARTIAL_DATE, max_length=10)] | None = None


class DiagnosisRemove(Closed):
    reason: Annotated[str, StringConstraints(min_length=1, max_length=500)]
