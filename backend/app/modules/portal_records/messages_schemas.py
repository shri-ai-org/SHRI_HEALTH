"""The patient portal's message threads (#398's PortalMessage* schemas in portal.yaml, x-owner
anand). Field names are the contract's camelCase."""
from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .schemas import Out


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


Author = Literal["patient", "clinic"]
ThreadStatus = Literal["open", "closed"]


class PortalMessage(Out):
    id: UUID
    author: Author
    author_name: str | None = Field(default=None, max_length=200)
    body: str = Field(min_length=1, max_length=4000)
    sent_at: datetime


class PortalMessageThreadSummary(Out):
    id: UUID
    subject: str = Field(min_length=3, max_length=200)
    status: ThreadStatus
    created_at: datetime
    last_message_at: datetime
    last_message_from: Author | None = None


class PortalMessageThread(PortalMessageThreadSummary):
    messages: list[PortalMessage] = Field(max_length=500)


class PortalMessageThreadList(Out):
    items: list[PortalMessageThreadSummary] = Field(max_length=100)
    next_cursor: str | None = None


class PortalMessageCreate(Closed):
    subject: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=1, max_length=4000)


class PortalMessageReply(Closed):
    body: str = Field(min_length=1, max_length=4000)
