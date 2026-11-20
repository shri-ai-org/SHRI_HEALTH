"""The staff inbox and messages (contracts/openapi/modules/inbox.yaml, x-owner anand; contract
batch 3, D77-D81). Each route's operation_id is the contract's operationId and the permission
(`require`) its first dependency. The rules are in service.py; the data in repository.py.

- ``listInboxItems``, ``getInboxSummary``, ``getInboxItem``: the user's items (BATCH3_PLAN §5).
- ``updateInboxItem`` (merge patch, If-Match): take, reassign, status, priority, due time.
- ``completeInboxItem``, ``cancelInboxItem``: close an item.
- ``replyToInboxItem``, ``createMessage``: a reply on a thread, a new message or task; core's
  tenant_db claims their optional Idempotency-Key.

Every write commits once, with its thread events, its events and core's audit row. Audited reads
and writes name the item's patient (x-audit ``patient: result``; ``body:/patientId`` for
createMessage), except a chart the user may not open, whose read names none. ``/inbox/summary``
is declared before ``/inbox/{inboxItemId}`` so that it matches first.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Path, Query, Request, Response, status
from pydantic import AwareDatetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import access as core_access
from app.core import audit as core_audit
from app.core import events as core_events
from app.core.deps import CurrentUser, require, tenant_db

from . import schemas as s
from . import service
from .repository import InboxStore, SqlInboxStore

router = APIRouter(tags=["inbox"])

AuditPatients = Callable[[Request, Iterable[UUID]], None]
API = "/api/v1"
ITEM = "/inbox/{inboxItemId}"


def inbox_store() -> InboxStore:
    return SqlInboxStore()


def chart_view() -> service.ChartView:
    """FastAPI dependency: core's chart access, read without refusing or auditing (D37)."""
    return core_access.chart_access


def chart_check() -> service.ChartCheck:
    """FastAPI dependency: core's restricted-chart check (404, or 403 break-glass-required)."""
    return core_access.ensure_chart_access


def audit_hook() -> AuditPatients:
    """FastAPI dependency: core's audit hook naming the patients."""
    return core_audit.audit_patients


def publisher() -> service.Publish:
    """FastAPI dependency: core's event publisher (in the request's transaction)."""
    return core_events.publish


DB = Annotated[AsyncSession, Depends(tenant_db)]
Store = Annotated[InboxStore, Depends(inbox_store)]
View = Annotated[service.ChartView, Depends(chart_view)]
Check = Annotated[service.ChartCheck, Depends(chart_check)]
Audit = Annotated[AuditPatients, Depends(audit_hook)]
Publish = Annotated[service.Publish, Depends(publisher)]
ItemId = Annotated[UUID, Path(alias="inboxItemId")]
IfMatch = Annotated[str | None, Header(alias="If-Match", max_length=128)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]
Kinds = Annotated[list[Annotated[str, Query(max_length=40)]] | None,
                  Query(alias="itemType", max_length=20)]
Statuses = Annotated[list[s.Status] | None, Query(alias="status", max_length=5)]
Priorities = Annotated[list[s.Priority] | None, Query(alias="priority", max_length=4)]


def _shown(response: Response, request: Request, audit: AuditPatients,
           shown: service.Shown, *, write: bool = False) -> s.InboxItem:
    # x-audit patient "result": a read names the charts it showed; a write names the item's
    # patient even when the user may not open the chart.
    audit(request, shown.written if write else shown.patients)
    response.headers["ETag"] = service.etag(shown.version)
    return shown.item


@router.get("/inbox", operation_id="listInboxItems", response_model=s.InboxItemList,
            response_model_exclude_none=True)
async def list_inbox_items(
    user: Annotated[CurrentUser, Depends(require("inbox:read"))], request: Request, db: DB,
    store: Store, view: View, check: Check, audit: Audit,
    limit: Limit = 25, cursor: Cursor = None, view_name: Annotated[s.View, Query(alias="view")]
    = "assigned", item_type: Kinds = None, status_: Statuses = None,
    priority: Priorities = None,
    patient_id: Annotated[UUID | None, Query(alias="patientId")] = None,
    facility_id: Annotated[UUID | None, Query(alias="facilityId")] = None,
    due_before: Annotated[AwareDatetime | None, Query(alias="dueBefore")] = None,
) -> s.InboxItemList:
    found, patients = await service.list_items(
        db, store, view, check, user, view_name=view_name, item_types=item_type or (),
        statuses=status_ or (), priorities=priority or (), patient_id=patient_id,
        facility_id=facility_id, due_before=due_before, limit=limit, cursor=cursor)
    audit(request, patients)  # x-audit patient "result": the patients shown
    return found


@router.get("/inbox/summary", operation_id="getInboxSummary", response_model=s.InboxSummary)
async def get_inbox_summary(
    user: Annotated[CurrentUser, Depends(require("inbox:read"))], db: DB, store: Store,
) -> s.InboxSummary:
    return await service.summary(db, store, user)


@router.get(ITEM, operation_id="getInboxItem", response_model=s.InboxItem,
            response_model_exclude_none=True)
async def get_inbox_item(
    user: Annotated[CurrentUser, Depends(require("inbox:read"))], item_id: ItemId,
    request: Request, response: Response, db: DB, store: Store, view: View, audit: Audit,
) -> s.InboxItem:
    return _shown(response, request, audit,
                  await service.get_item(db, store, view, user, item_id))


@router.patch(ITEM, operation_id="updateInboxItem", response_model=s.InboxItem,
              response_model_exclude_none=True)
async def update_inbox_item(
    user: Annotated[CurrentUser, Depends(require("inbox:update"))], item_id: ItemId,
    body: s.InboxItemPatch, request: Request, response: Response, db: DB, store: Store,
    view: View, publish: Publish, audit: Audit, if_match: IfMatch = None,
) -> s.InboxItem:
    shown = await service.update_item(db, store, view, publish, user, item_id, body, if_match)
    item = _shown(response, request, audit, shown, write=True)
    await db.commit()  # the change, its thread events and inbox.item-assigned
    return item


@router.post(f"{ITEM}/complete", operation_id="completeInboxItem", response_model=s.InboxItem,
             response_model_exclude_none=True)
async def complete_inbox_item(
    user: Annotated[CurrentUser, Depends(require("inbox:complete"))], item_id: ItemId,
    request: Request, response: Response, db: DB, store: Store, view: View, publish: Publish,
    audit: Audit, body: Annotated[s.CompleteRequest | None, Body()] = None,
) -> s.InboxItem:
    shown = await service.complete_item(db, store, view, publish, user, item_id, body)
    item = _shown(response, request, audit, shown, write=True)
    await db.commit()
    return item


@router.post(f"{ITEM}/cancel", operation_id="cancelInboxItem", response_model=s.InboxItem,
             response_model_exclude_none=True)
async def cancel_inbox_item(
    user: Annotated[CurrentUser, Depends(require("inbox:update"))], item_id: ItemId,
    body: s.CancelRequest, request: Request, response: Response, db: DB, store: Store,
    view: View, publish: Publish, audit: Audit,
) -> s.InboxItem:
    shown = await service.cancel_item(db, store, view, publish, user, item_id, body)
    item = _shown(response, request, audit, shown, write=True)
    await db.commit()
    return item


@router.post(f"{ITEM}/replies", operation_id="replyToInboxItem", response_model=s.InboxItem,
             response_model_exclude_none=True)
async def reply_to_inbox_item(
    user: Annotated[CurrentUser, Depends(require("messages:create"))], item_id: ItemId,
    body: s.ReplyRequest, request: Request, response: Response, db: DB, store: Store,
    view: View, check: Check, publish: Publish, audit: Audit,
) -> s.InboxItem:
    shown = await service.reply(db, store, view, check, publish, user, item_id, body)
    item = _shown(response, request, audit, shown, write=True)
    await db.commit()  # the reply, the hand-back and inbox.item-assigned
    return item


@router.post("/messages", operation_id="createMessage", status_code=status.HTTP_201_CREATED,
             response_model=s.InboxItem, response_model_exclude_none=True)
async def create_message(
    user: Annotated[CurrentUser, Depends(require("messages:create"))], body: s.MessageCreate,
    request: Request, response: Response, db: DB, store: Store, view: View, check: Check,
    publish: Publish, audit: Audit,
) -> s.InboxItem:
    shown = await service.create_message(db, store, view, check, publish, user, body)
    audit(request, [body.patient_id] if body.patient_id else [])  # x-audit body:/patientId
    response.headers["ETag"] = service.etag(shown.version)
    response.headers["Location"] = f"{API}/inbox/{shown.item.id}"
    await db.commit()  # the item, its created event and inbox.item-assigned
    return shown.item

