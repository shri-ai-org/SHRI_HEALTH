"""The pharmacy messages as Pydantic models: the NewRx (a signed prescription) and the pharmacy's
RxStatus reply, mirroring ``contracts/partners/pharmacy/*.schema.json`` field for field.

The JSON Schemas are the contract; these models are how the backend builds and checks them,
because no JSON Schema validator is in the backend's lockfiles. ``tests/test_messages.py`` proves
the two agree: every recorded example is valid under both, every mutation of one is refused by
both, and they name the same fields.

Like the schemas, every object is closed (an unknown field is refused) and an optional field may
be left out but never sent as ``null``. The base is the eligibility messages' (a copy, so this
module, Thulasi's, doesn't import Vimal's).
"""

from __future__ import annotations

import re
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

NEW_RX: Final = "NewRx"
RX_STATUS: Final = "RxStatus"
SCHEMA_VERSION: Final = "1.0"

UUID_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
DATE_PATTERN = r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
TIMESTAMP_PATTERN = (r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
                     r"(\.[0-9]{1,6})?Z$")
QUANTITY_PATTERN = r"^[0-9]{1,6}(\.[0-9]{1,3})?$"
ZERO_PATTERN = re.compile(r"^0+(\.0+)?$")


def _not_zero(value: str) -> str:
    if ZERO_PATTERN.match(value):
        raise ValueError("a quantity is greater than zero")
    return value


def _real_uuid(value: str) -> str:
    UUID(value)
    return value


def _real_date(value: str) -> str:
    date.fromisoformat(value)
    return value


def _real_time(value: str) -> str:
    datetime.fromisoformat(value)
    return value


Id = Annotated[str, StringConstraints(pattern=UUID_PATTERN, max_length=36),
               AfterValidator(_real_uuid)]
DateText = Annotated[str, StringConstraints(pattern=DATE_PATTERN, max_length=10),
                     AfterValidator(_real_date)]
Timestamp = Annotated[str, StringConstraints(pattern=TIMESTAMP_PATTERN, max_length=35),
                      AfterValidator(_real_time)]
NamePart = Annotated[str, StringConstraints(min_length=1, max_length=100)]
Npi = Annotated[str, StringConstraints(pattern=r"^[0-9]{10}$", max_length=10)]


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


# -------------------------------------------------------------------------------- the NewRx
class PersonName(Message):
    family: NamePart
    given: Annotated[list[NamePart], Field(max_length=5)] | None = None


class Prescriber(Message):
    npi: Npi
    name: PersonName


class Patient(Message):
    name: PersonName
    birth_date: DateText


class Pharmacy(Message):
    ncpdp_id: Annotated[str, StringConstraints(pattern=r"^[0-9]{7}$", max_length=7)]
    npi: Npi | None = None


class Quantity(Message):
    value: Annotated[str, StringConstraints(pattern=QUANTITY_PATTERN, max_length=10),
                     AfterValidator(_not_zero)]
    unit: Annotated[str, StringConstraints(min_length=1, max_length=32)]


class Medication(Message):
    rxnorm_code: Annotated[str, StringConstraints(pattern=r"^[0-9]{1,10}$",
                                                  max_length=10)] | None = None
    description: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    quantity: Quantity
    days_supply: Annotated[int, Field(ge=1, le=365)] | None = None
    refills: Annotated[int, Field(ge=0, le=11)]
    substitution_allowed: bool
    sig: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    dea_schedule: Literal["CII", "CIII", "CIV", "CV"] | None = None
    note_to_pharmacist: Annotated[str, StringConstraints(min_length=1,
                                                         max_length=210)] | None = None


class NewRx(Message):
    message_type: Literal["NewRx"]
    schema_version: Literal["1.0"]
    correlation_id: Id
    created_at: Timestamp
    signed_at: Timestamp
    prescriber: Prescriber
    patient: Patient
    pharmacy: Pharmacy
    medication: Medication


# --------------------------------------------------------------------------- the reply
class Rejection(Message):
    code: Annotated[str, StringConstraints(pattern=r"^[0-9]{3}$", max_length=3)]
    description_code: Annotated[str, StringConstraints(pattern=r"^[0-9]{1,4}$",
                                                       max_length=4)] | None = None
    message: Annotated[str, StringConstraints(min_length=1, max_length=500)] | None = None


class RxStatus(Message):
    message_type: Literal["RxStatus"]
    schema_version: Literal["1.0"]
    correlation_id: Id
    response_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9._:-]{1,60}$",
                                                  max_length=60)]
    responded_at: Timestamp
    status: Literal["accepted", "rejected"]
    rejection: Rejection | None = None

    @model_validator(mode="after")
    def _status_rules(self) -> Self:
        """The schema's allOf: a rejection says why; an acceptance has no rejection."""
        if self.status == "rejected" and self.rejection is None:
            raise ValueError("a rejection gives its reason")
        if self.status == "accepted" and self.rejection is not None:
            raise ValueError("an acceptance has no rejection")
        return self
