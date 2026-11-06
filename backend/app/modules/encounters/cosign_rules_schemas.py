"""Co-signature rules (inventory #87-89, #251; FRS FR-ENC-01; encounters.yaml CosignRule,
CosignRuleCreate, CosignRulePatch, CosignRuleList). Practice settings, no patient data."""

from __future__ import annotations

from datetime import date, datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field, StringConstraints

from .schemas import Closed, Out

State = Annotated[str, StringConstraints(pattern=r"^[A-Z]{2}$", max_length=2)]
Days = Annotated[int, Field(ge=1, le=90)]


class CosignRule(Out):
    id: UUID
    supervisee_provider_id: UUID
    supervising_provider_id: UUID
    state: str | None = None
    applies_to_notes: bool
    applies_to_prescriptions: bool
    applies_to_orders: bool
    cosign_within_days: int | None = None
    effective_from: date
    effective_to: date | None = None
    created_at: datetime
    updated_at: datetime


class CosignRuleList(Out):
    items: list[CosignRule]
    next_cursor: str | None = None


class CosignRuleCreate(Closed):
    supervisee_provider_id: UUID
    supervising_provider_id: UUID
    state: State | None = None
    applies_to_notes: bool = True
    applies_to_prescriptions: bool = False
    applies_to_orders: bool = False
    cosign_within_days: Days | None = None
    effective_from: date
    effective_to: date | None = None


class CosignRulePatch(Closed):
    """JSON merge patch; the supervisee can't change (end the rule and add a new one)."""
    supervising_provider_id: UUID | None = None
    applies_to_notes: bool | None = None
    applies_to_prescriptions: bool | None = None
    applies_to_orders: bool | None = None
    cosign_within_days: Days | None = None
    effective_to: date | None = None
