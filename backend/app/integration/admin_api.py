"""Read-only interoperability screens (section 8 of the demo plan; x-owner thulasi): the integration
message monitor (listIntegrationMessages) and a patient's record as FHIR R4 resources
(getPatientFhirRecord). Nothing here sends, replays or changes a message or a record.

- **The monitor** reads ``admin.integration_message`` with its endpoint under the clinic's row
  security. It shows the flow only: partner, endpoint, direction, message type, status,
  attempts and times, the partner's acknowledgement code, and the record a message is about
  (outbox payloads hold record IDs only, T29). Never the payload, the patient or the partner's
  free-text error, which can carry patient data.
- **The FHIR record** serializes the patient's resources exactly as ``/fhir/r4`` serves them
  (``app.fhir.serializer.to_fhir``, US Core), from the request's own ``tenant_db`` session, so
  the screens stay on ``/api/v1`` (D1) and the chart rule is the API's (D37: break-glass), not
  ``/fhir``'s (D22). Drafts are left out; entered-in-error records are included with their
  status, as FHIR has them. At most 500 resources, with ``truncated`` when there were more.
"""
from __future__ import annotations

import base64
import binascii
import datetime as dt
import uuid
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, FastAPI, Path, Query
from sqlalchemy import String, cast, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core.config import Settings
from app.core.deps import CurrentUser, require, tenant_db
from app.core.errors import InvalidCursor, ValidationFailed, field_error
from app.core.routing import API_PREFIX
from app.db.constraints import patient_column
from app.db.models import FHIR_RESOURCES
from app.fhir.serializer import to_fhir

router = APIRouter(tags=["platform"])

DB = Annotated[AsyncSession, Depends(tenant_db)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


def _encode(offset: int) -> str:
    return base64.urlsafe_b64encode(f"o:{offset}".encode()).decode().rstrip("=")


def _decode(cursor: str | None) -> int:
    if cursor is None:
        return 0
    try:
        raw = base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError) as bad:
        raise InvalidCursor() from bad
    kind, _, number = raw.partition(":")
    if kind != "o" or not number.isdigit():
        raise InvalidCursor()
    return int(number)


# ------------------------------------------------------------------- integration messages
Partner = Literal["erx", "lab", "clearinghouse", "fax", "notification"]
Direction = Literal["outbound", "inbound"]
Status = Literal["queued", "sending", "sent", "acknowledged", "received", "processed", "failed",
                 "dead-letter"]
#: The record a message is about: the ID keys outbox payloads use (IDs only, T29).
RELATED = {"prescriptionId": "prescription", "orderId": "order",
           "eligibilityCheckId": "eligibility-check"}

_MESSAGES = text("""
SELECT m.id, e.kind, e.name, m.direction, m.message_type, m.status, m.attempts, m.created_at,
       m.updated_at, m.ack_code, m.payload
FROM admin.integration_message m
JOIN admin.integration_endpoint e ON e.id = m.endpoint_id
WHERE (CAST(:partner AS text) IS NULL OR e.kind::text = CAST(:partner AS text))
  AND (CAST(:direction AS text) IS NULL OR m.direction::text = CAST(:direction AS text))
  AND (CAST(:status AS text) IS NULL OR m.status::text = CAST(:status AS text))
  AND (CAST(:start AS timestamptz) IS NULL OR m.created_at >= CAST(:start AS timestamptz))
  AND (CAST(:end AS timestamptz) IS NULL OR m.created_at < CAST(:end AS timestamptz))
ORDER BY m.created_at DESC, m.id DESC
LIMIT :limit OFFSET :offset
""")
_ZONE = text("SELECT timezone FROM admin.tenant WHERE id = :id")


@router.get("/admin/integration-messages", operation_id="listIntegrationMessages")
async def list_integration_messages(
        user: Annotated[CurrentUser, Depends(require("integration-messages:read"))], db: DB,
        partner: Partner | None = None, direction: Direction | None = None,
        status: Status | None = None,
        date_from: Annotated[dt.date | None, Query(alias="dateFrom")] = None,
        date_to: Annotated[dt.date | None, Query(alias="dateTo")] = None,
        limit: Limit = 25, cursor: Cursor = None) -> dict[str, Any]:
    if date_from and date_to and date_to < date_from:
        raise ValidationFailed(errors=[field_error("query", "dateTo", "out-of-range")])
    start = end = None
    if date_from or date_to:
        zone = ZoneInfo((await db.execute(_ZONE, {"id": user.organization_id})).scalar_one()
                        or "UTC")
        if date_from:
            start = dt.datetime.combine(date_from, dt.time(), zone)
        if date_to:
            end = dt.datetime.combine(date_to + dt.timedelta(days=1), dt.time(), zone)
    offset = _decode(cursor)
    rows = await db.execute(_MESSAGES, {
        "partner": partner, "direction": direction, "status": status, "start": start,
        "end": end, "limit": limit + 1, "offset": offset})
    found = [_message(r) for r in rows]
    if len(found) > limit:
        return {"items": found[:limit], "nextCursor": _encode(offset + limit)}
    return {"items": found}


def _message(r: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": str(r.id), "partner": str(r.kind), "endpointName": r.name,
        "direction": str(r.direction), "messageType": r.message_type, "status": str(r.status),
        "attempts": r.attempts, "createdAt": r.created_at.isoformat()}
    if r.updated_at is not None and r.updated_at != r.created_at:
        item["lastAttemptAt"] = r.updated_at.isoformat()
    if r.ack_code:
        item["errorCode"] = r.ack_code
    payload = r.payload if isinstance(r.payload, dict) else {}
    for key, kind in RELATED.items():
        value = payload.get(key)
        if isinstance(value, str):
            try:
                item["relatedId"] = str(uuid.UUID(value))
            except ValueError:
                continue
            item["relatedType"] = kind
            break
    return item


# ------------------------------------------------------------------------- the FHIR record
FHIR_TYPES = ("Patient", "Condition", "Observation", "MedicationRequest", "AllergyIntolerance",
              "DiagnosticReport")
MAX_ENTRIES = 500


@router.get("/patients/{patientId}/fhir-record", operation_id="getPatientFhirRecord")
async def get_patient_fhir_record(
        user: Annotated[CurrentUser, Depends(require("patients:read"))], db: DB,
        patient_id: Annotated[uuid.UUID, Path(alias="patientId")],
        types: Annotated[str | None, Query(max_length=200)] = None) -> dict[str, Any]:
    wanted: tuple[str, ...] = FHIR_TYPES
    if types is not None:
        wanted = tuple(t.strip() for t in types.split(",") if t.strip())
        if not wanted or any(t not in FHIR_TYPES for t in wanted):
            raise ValidationFailed(errors=[field_error("query", "types", "not-allowed-value")])
    await core_access.ensure_chart_access(db, user, patient_id)  # 404 or 403 break-glass
    entries: list[dict[str, Any]] = []
    truncated = False
    for rtype in FHIR_TYPES:
        if rtype not in wanted:
            continue
        cls = FHIR_RESOURCES[rtype]
        column = cls.__table__.c.id if rtype == "Patient" else patient_column(cls.__table__)
        if column is None:
            continue
        query = select(cls).where(column == patient_id)
        if "status" in cls.__table__.c:
            query = query.where(cast(cls.__table__.c.status, String) != "draft")
        query = query.order_by(cls.__table__.c.id).limit(MAX_ENTRIES + 1 - len(entries))
        for obj in (await db.execute(query)).scalars():
            if len(entries) == MAX_ENTRIES:
                truncated = True
                break
            entries.append({"fullUrl": f"urn:uuid:{obj.id}", "resource": to_fhir(obj)})
        if truncated:
            break
    bundle: dict[str, Any] = {"resourceType": "Bundle", "type": "collection",
                              "total": len(entries), "entry": entries}
    if truncated:
        bundle["truncated"] = True
    return bundle


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
