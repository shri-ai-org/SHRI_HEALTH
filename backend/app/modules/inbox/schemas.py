"""The inbox's request and response shapes (contracts/openapi/modules/inbox.yaml, x-owner anand).
Field names are the contract's camelCase."""
from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


Status = Literal["open", "in-progress", "on-hold", "completed", "cancelled"]
OpenStatus = Literal["open", "in-progress", "on-hold"]
Priority = Literal["routine", "urgent", "asap", "stat"]
AssigneeType = Literal["user", "role"]
ThreadEventType = Literal["created", "assigned", "status-change", "comment", "escalated"]
View = Literal["assigned", "mine", "queue", "sent", "facility"]


class StaffRef(Out):
    id: UUID
    display_name: str = Field(max_length=200)


class Assignee(Out):
    type: AssigneeType
    id: UUID
    display_name: str = Field(max_length=200)


class AssigneeInput(Closed):
    type: AssigneeType
    id: UUID


class Subject(Closed):
    type: str = Field(min_length=1, max_length=40)
    id: UUID


class HumanName(Out):
    given: list[str] = Field(default_factory=list, max_length=5)
    family: str = Field(max_length=100)
    prefix: str | None = Field(default=None, max_length=20)
    suffix: str | None = Field(default=None, max_length=20)


class InboxPatient(Out):
    id: UUID
    name: HumanName
    birth_date: date | None = None


class ThreadEvent(Out):
    event: ThreadEventType
    at: datetime
    by: StaffRef | None = None
    from_status: Status | None = None
    to_status: Status | None = None
    assignee: Assignee | None = None
    escalation_level: int | None = Field(default=None, ge=1, le=9)
    comment: str | None = Field(default=None, max_length=4000)
    from_patient: bool | None = None
    to_patient: bool | None = None


class InboxItem(Out):
    id: UUID
    item_type: str = Field(max_length=40)
    status: Status
    priority: Priority
    title: str = Field(max_length=200)
    body: str | None = Field(default=None, max_length=4000)
    assignee: Assignee | None = None  # every item has one; an item without one shows none
    facility_id: UUID
    due_at: datetime | None = None
    overdue: bool
    escalation_level: int = Field(ge=0, le=9)
    escalated_at: datetime | None = None
    restricted: bool
    patient: InboxPatient | None = None
    subject: Subject | None = None
    encounter_id: UUID | None = None
    created_by: StaffRef | None = None
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    completed_by: StaffRef | None = None
    thread: list[ThreadEvent] | None = Field(default=None, max_length=500)


class InboxItemList(Out):
    items: list[InboxItem] = Field(max_length=100)
    next_cursor: str | None = None


class TypeCount(Out):
    item_type: str = Field(max_length=40)
    open: int = Field(ge=0)
    in_progress: int = Field(ge=0)
    on_hold: int = Field(ge=0)
    overdue: int = Field(ge=0)


class InboxSummary(Out):
    total: int = Field(ge=0)
    overdue: int = Field(ge=0)
    by_type: list[TypeCount] = Field(max_length=40)


class MessageCreate(Closed):
    kind: Literal["message", "task"]
    assignee: AssigneeInput
    facility_id: UUID
    title: str = Field(min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=4000)
    priority: Priority = "routine"
    due_at: AwareDatetime | None = None
    patient_id: UUID | None = None
    subject: Subject | None = None


class InboxItemPatch(Closed):
    """A JSON merge patch: only the members sent change (``model_fields_set``); ``dueAt: null``
    clears the due time."""

    assignee: AssigneeInput | None = None
    status: OpenStatus | None = None
    priority: Priority | None = None
    due_at: AwareDatetime | None = None


class CompleteRequest(Closed):
    comment: str | None = Field(default=None, max_length=2000)


class CancelRequest(Closed):
    reason: str = Field(min_length=1, max_length=500)


class ReplyRequest(Closed):
    text: str = Field(min_length=1, max_length=4000)
    assign_back: bool = True
    to_patient: bool = False
