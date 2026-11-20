"""Patient portal: secure messages with the practice (#398;
portal.yaml ``/portal/me/messages``; x-owner anand). See messages_service.py for the rules.

Portal routes never use a staff session: ``require_patient`` checks role PAT's permission on the
portal session, and ``portal_db`` runs as ``shri_portal`` with the session's patient set (D93).
Core writes the audit row with the patient from the session (x-audit ``patient: session``,
``actor: patient``) and keeps an Idempotency-Key for that patient (x-idempotency: supported).
"""
from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import PortalPatient, portal_db, require_patient

from . import messages_schemas as s
from . import messages_service as service
from .messages_repository import MessageStore, SqlMessageStore

router = APIRouter(tags=["portal"])
MESSAGES = "/portal/me/messages"


def message_store() -> MessageStore:
    return SqlMessageStore()


DB = Annotated[AsyncSession, Depends(portal_db)]
Store = Annotated[MessageStore, Depends(message_store)]
Reading = Annotated[PortalPatient, Depends(require_patient("portal-records:read"))]
Writing = Annotated[PortalPatient, Depends(require_patient("portal-messages:create"))]
ThreadId = Annotated[UUID, Path(alias="threadId")]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]


@router.get(MESSAGES, operation_id="listPortalMessageThreads",
            response_model=s.PortalMessageThreadList, response_model_exclude_none=True)
async def list_portal_message_threads(patient: Reading, db: DB, store: Store, limit: Limit = 25,
                                      cursor: Cursor = None) -> s.PortalMessageThreadList:
    return await service.list_threads(db, store, patient, limit=limit, cursor=cursor)


@router.post(MESSAGES, operation_id="createPortalMessage", status_code=status.HTTP_201_CREATED,
             response_model=s.PortalMessageThread, response_model_exclude_none=True)
async def create_portal_message(patient: Writing, body: s.PortalMessageCreate,
                                response: Response, db: DB, store: Store
                                ) -> s.PortalMessageThread:
    created = await service.create_thread(db, store, patient, body)
    await db.commit()  # the item, its first message and inbox.item-assigned: all or nothing
    response.headers["Location"] = f"/api/v1{MESSAGES}/{created.id}"
    return created


@router.get(f"{MESSAGES}/{{threadId}}", operation_id="getPortalMessageThread",
            response_model=s.PortalMessageThread, response_model_exclude_none=True)
async def get_portal_message_thread(patient: Reading, thread_id: ThreadId, db: DB,
                                    store: Store) -> s.PortalMessageThread:
    return await service.get_thread(db, store, patient, thread_id)


@router.post(f"{MESSAGES}/{{threadId}}/replies", operation_id="replyToPortalMessageThread",
             response_model=s.PortalMessageThread, response_model_exclude_none=True)
async def reply_to_portal_message_thread(patient: Writing, thread_id: ThreadId,
                                         body: s.PortalMessageReply, db: DB, store: Store
                                         ) -> s.PortalMessageThread:
    replied = await service.reply(db, store, patient, thread_id, body)
    await db.commit()
    return replied
