"""Request and response shapes for the billing API, from contracts/openapi/modules/billing.yaml.

Field names are the contract's camelCase (aliases). `PaymentCreate` is closed
(`additionalProperties: false`), so an unknown field is `422 validation-failed`. Money is a
decimal string with two fraction digits (`Money.yaml`, D40): parsed into an exact `Decimal`,
never a float, and written back the same way.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel

PaymentMethod = Literal["cash", "card", "check", "ach", "other"]
MoneyValue = Annotated[str, StringConstraints(max_length=13, pattern=r"^-?\d{1,9}\.\d{2}$")]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class Money(Closed):
    value: MoneyValue
    currency: Literal["USD"]

    @property
    def amount(self) -> Decimal:
        return Decimal(self.value)

    @classmethod
    def of(cls, amount: Decimal, currency: str = "USD") -> Money:
        return cls.model_validate({"value": f"{amount.quantize(Decimal('0.01'))}",
                                   "currency": currency})


class PaymentCreate(Closed):
    amount: Money
    method: PaymentMethod
    appointment_id: UUID | None = None
    encounter_id: UUID | None = None
    card_session_id: UUID | None = None
    check_number: Annotated[str, StringConstraints(max_length=40)] | None = None
    note: Annotated[str, StringConstraints(max_length=500)] | None = None


class Payment(Out):
    id: UUID
    patient_id: UUID
    appointment_id: UUID | None = None
    encounter_id: UUID | None = None
    amount: Money
    method: PaymentMethod
    processor_reference: str | None = None
    receipt_file_id: UUID
    collected_at: datetime
    collected_by_user_id: UUID
    refund: bool
    refund_of_payment_id: UUID | None = None
