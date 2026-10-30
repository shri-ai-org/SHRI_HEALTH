"""The clearinghouse messages as Pydantic models: the eligibility request (our 270) and the payer's
reply (our 271), mirroring ``contracts/partners/clearinghouse/*.schema.json`` field for field.

The JSON Schemas are the contract; these models are how the backend builds and checks them,
because no JSON Schema validator is in the backend's lockfiles. ``tests/test_messages.py`` proves
the two agree: every recorded example is valid under both, every mutation of one is refused by
both, and they name the same fields.

Like the schemas, every object is closed (an unknown field is refused) and an optional field may
be left out but never sent as ``null``.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Any, Final, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)
from pydantic.alias_generators import to_camel

REQUEST_TYPE: Final = "270"
RESPONSE_TYPE: Final = "271"
SCHEMA_VERSION: Final = "1.0"

ServiceTypeCode = Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{1,2}$", max_length=2)]
MemberId = Annotated[str, StringConstraints(min_length=1, max_length=200)]
NamePart = Annotated[str, StringConstraints(min_length=1, max_length=100)]
Relationship = Literal["spouse", "child", "parent", "common", "other", "injured"]
Result = Literal["active", "inactive", "member-not-found", "error"]
BenefitType = Literal["active-coverage", "copay", "coinsurance", "deductible", "out-of-pocket",
                      "limitation", "non-covered"]
UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
TIMESTAMP_PATTERN = (r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
                     r"(\.[0-9]{1,6})?Z$")


def _lower_uuid(value: str) -> str:
    UUID(value)  # also a real UUID, not just the shape
    return value


def _real_date(value: str) -> str:
    date.fromisoformat(value)
    return value


def _real_time(value: str) -> str:
    datetime.fromisoformat(value)
    return value


Id = Annotated[str, StringConstraints(pattern=UUID_PATTERN, max_length=36),
               AfterValidator(_lower_uuid)]
DateText = Annotated[str, StringConstraints(pattern=DATE_PATTERN, max_length=10),
                     AfterValidator(_real_date)]
Timestamp = Annotated[str, StringConstraints(pattern=TIMESTAMP_PATTERN, max_length=35),
                      AfterValidator(_real_time)]
Amount = Annotated[str, StringConstraints(pattern=r"^[0-9]{1,9}\.[0-9]{2}$", max_length=12)]
Percent = Annotated[str, StringConstraints(
    pattern=r"^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$", max_length=6)]


class Message(BaseModel):
    """A closed object of a partner message: camelCase names, no unknown fields, no nulls."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid",
                              strict=True, frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _no_nulls(cls, data: Any) -> Any:
        if isinstance(data, dict) and any(v is None for v in data.values()):
            raise ValueError("a member is null: leave it out instead")
        return data

    def as_json(self) -> dict[str, Any]:
        """The message as the partner sees it: camelCase, absent members left out."""
        found: dict[str, Any] = self.model_dump(mode="json", by_alias=True, exclude_none=True)
        return found


# ------------------------------------------------------------------------------- the request
class PersonName(Message):
    family: NamePart
    given: Annotated[list[NamePart], Field(max_length=5)] | None = None


class RequestPayer(Message):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200)]
    payer_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._-]{1,40}$",
                                               max_length=40)] | None = None


class RequestProvider(Message):
    npi: Annotated[str, StringConstraints(pattern=r"^[0-9]{10}$", max_length=10)]


class Subscriber(Message):
    member_id: MemberId
    name: PersonName
    birth_date: DateText
    group_number: Annotated[str, StringConstraints(min_length=1, max_length=80)] | None = None


class Dependent(Message):
    name: PersonName
    birth_date: DateText
    relationship_to_subscriber: Relationship
    member_id: MemberId | None = None


class EligibilityRequest(Message):
    message_type: Literal["270"]
    schema_version: Literal["1.0"]
    correlation_id: Id
    created_at: Timestamp
    payer: RequestPayer
    provider: RequestProvider
    subscriber: Subscriber
    dependent: Dependent | None = None
    service_date: DateText
    service_type_codes: Annotated[list[ServiceTypeCode], Field(min_length=1, max_length=10)]

    @model_validator(mode="after")
    def _unique_codes(self) -> Self:
        if len(set(self.service_type_codes)) != len(self.service_type_codes):
            raise ValueError("serviceTypeCodes repeats a code")
        return self


# --------------------------------------------------------------------------------- the reply
class Money(Message):
    value: Amount
    currency: Literal["USD"]


class Plan(Message):
    name: Annotated[str, StringConstraints(min_length=1, max_length=200)] | None = None
    group_number: Annotated[str, StringConstraints(min_length=1, max_length=80)] | None = None
    coverage_start_date: DateText | None = None
    coverage_end_date: DateText | None = None


class Benefit(Message):
    benefit_type: BenefitType
    service_type_code: ServiceTypeCode | None = None
    coverage_level: Literal["individual", "family"] | None = None
    network: Literal["in", "out", "na"] | None = None
    time_period: Literal["calendar-year", "plan-year", "visit", "remaining",
                         "lifetime"] | None = None
    amount: Money | None = None
    percent: Percent | None = None
    authorization_required: bool | None = None
    message: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None


class PayerError(Message):
    code: Annotated[str, StringConstraints(pattern=r"^[A-Z0-9]{2}$", max_length=2)]
    follow_up_action: Literal["C", "N", "P", "R", "S", "W", "X", "Y"] | None = None
    message: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None


class EligibilityResponse(Message):
    message_type: Literal["271"]
    schema_version: Literal["1.0"]
    correlation_id: Id
    response_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:-]{1,60}$",
                                                  max_length=60)]
    responded_at: Timestamp
    result: Result
    plan: Plan | None = None
    benefits: Annotated[list[Benefit], Field(max_length=200)] | None = None
    errors: Annotated[list[PayerError], Field(min_length=1, max_length=10)] | None = None

    @model_validator(mode="after")
    def _result_rules(self) -> Self:
        """The schema's allOf: an error lists its errors; no plan or benefits without a member."""
        if self.result == "error" and self.errors is None:
            raise ValueError("an error result lists its errors")
        if self.result in ("error", "member-not-found") and (
                self.plan is not None or self.benefits is not None):
            raise ValueError("no plan or benefits when the payer found no coverage")
        return self
