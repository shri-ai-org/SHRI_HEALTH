"""Request and response shapes for the file service, from contracts/openapi/modules/files.yaml
and the shared ``Operation`` (components/schemas/Operation.yaml).

Field names are the contract's camelCase (aliases). ``UploadUrlRequest`` is closed
(``additionalProperties: false``), so an unknown field (a client file name, say) is ``422
validation-failed``: client file names are never stored.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel

FilePurpose = Literal["insurance-card", "identity", "receipt", "encounter-audio",
                      "after-visit-summary", "document", "fax", "ccda", "export",
                      "onboarding-import"]
OperationStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]


class Closed(BaseModel):
    """A request body the contract closes: unknown fields are refused."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Out(BaseModel):
    """A response body."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class UploadUrlRequest(Closed):
    purpose: FilePurpose
    content_type: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    size_bytes: Annotated[int, Field(ge=1, le=2147483648, strict=True)]
    sha256: Annotated[str, StringConstraints(pattern=r"^[0-9a-f]{64}$", max_length=64)]


class UploadTicket(Out):
    """A bearer secret in ``upload_url``: never logged (API_STANDARDS §15)."""

    file_id: UUID
    upload_url: str = Field(repr=False)
    upload_headers: dict[str, str] | None = None
    expires_at: datetime


class DownloadLink(Out):
    url: str = Field(repr=False)
    expires_at: datetime
    content_type: str
    size_bytes: int | None = None


class OperationResult(Out):
    type: str
    id: UUID


class Operation(Out):
    id: UUID
    kind: str
    status: OperationStatus
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None = None
    result: OperationResult | None = None
    error: dict[str, Any] | None = None
