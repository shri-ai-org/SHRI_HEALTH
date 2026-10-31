"""Request and response shapes for the eligibility API, from
contracts/openapi/modules/eligibility.yaml. Field names are the contract's camelCase (aliases); the
request body the contract closes (`additionalProperties: false`) forbids unknown fields.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

ServiceTypeCode = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{1,2}$", max_length=2)]
ServiceTypeCodes = Annotated[list[ServiceTypeCode], Field(min_length=1, max_length=10)]
Trigger = Literal["booking", "pre-visit-batch", "check-in", "manual"]


class Closed(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class EligibilityCheckCreate(Closed):
    coverage_id: UUID
    appointment_id: UUID | None = None
    service_type_codes: ServiceTypeCodes | None = None


class Money(Out):
    value: str  # a decimal string with two fraction digits (D40)
    currency: Literal["USD"] = "USD"


class EligibilityBenefit(Out):
    benefit_type: Literal["active-coverage", "copay", "coinsurance", "deductible",
                          "out-of-pocket", "limitation", "non-covered"]
    service_type_code: str | None = None
    coverage_level: Literal["individual", "family"] | None = None
    network: Literal["in", "out", "na"] | None = None
    time_period: Literal["calendar-year", "plan-year", "visit", "remaining",
                         "lifetime"] | None = None
    benefit_amount: Money | None = None
    percent: float | None = None  # the contract's number, 0 to 100
    authorization_required: bool | None = None
    message: str | None = None


class EligibilityCheck(Out):
    id: UUID
    patient_id: UUID
    coverage_id: UUID
    appointment_id: UUID | None = None
    trigger: Trigger
    status: Literal["pending", "complete", "error"]
    coverage_status: Literal["active", "inactive", "unknown"] | None = None
    plan_name: str | None = None
    coverage_start_date: date | None = None
    coverage_end_date: date | None = None
    copay: Money | None = None
    deductible: Money | None = None
    deductible_remaining_amount: Money | None = None
    benefits: list[EligibilityBenefit] | None = None
    error_code: str | None = None
    error_message: str | None = None
    requested_at: datetime
    responded_at: datetime | None = None
    expires_at: datetime | None = None


class EligibilityCheckList(Out):
    items: list[EligibilityCheck]
    next_cursor: str | None = None
