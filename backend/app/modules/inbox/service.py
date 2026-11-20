"""The staff inbox (contract batch 3: listInboxItems, getInboxSummary, getInboxItem,
updateInboxItem, completeInboxItem, cancelInboxItem, replyToInboxItem, createMessage; x-owner
anand; BATCH3_PLAN, DATA_OWNERSHIP §5.9, D37, D77-D81).

**Who sees an item** (BATCH3_PLAN §5): one of the user's facilities; a kind the user may read
(``KIND_PERMISSION``: the kind's own read permission, so the inbox never shows more than the
user's other screens); and the user's own item, a queue of one of their roles, one they sent,
or, for ADM, any item at their facilities (Q5). Anything else is ``404``, as for an item that
doesn't exist.

**Restricted charts** (D37, §10a): an item about a chart the user may not open (core's
``chart_access``: no grant, not on the care team) is shown with ``restricted: true`` and without
``patient``, ``body``, ``encounterId`` or any thread comment; a free-text title (a message, a
task, a patient's subject) becomes "Item about a restricted chart". Only its opened patients are
audited for a read. ``patientId`` naming such a chart, a message about one and ``toPatient`` on
one are ``403 break-glass-required``, through core's ``ensure_chart_access`` (audited).

**Changes**, each under the item's row lock, with its thread event and its event (data: the
kind, the priority or the status; never a title, a body or a reply, D81):
- PATCH (``If-Match``): taking an item from a queue of one's role, reassigning it (its assignee,
  or ADM), a status between open, in progress and on hold (the user it is assigned to), the
  priority or the due time (its assignee, a holder of its role, or its sender). A new assignee
  must work at the item's facility and be able to read its kind.
- complete: the user it is assigned to (for a ``patient-message``, also a holder of its role,
  since it has no sender); never a kind that its own action completes (``COMPLETED_BY_ACTION``).
- cancel: messages and tasks by their sender; a ``patient-message`` (no sender) by its assignee
  or a holder of its role. Completing or cancelling a ``patient-message`` closes the portal
  thread.
- reply: anyone who sees the item, through ``admin.inbox_reply``. ``assignBack`` hands a
  message or task between its assignee and its sender (``hand_back_to``). ``toPatient`` only on
  a ``patient-message``. The patient is not told outside the app yet: the integration engine
  has no ``portal-message`` email, whose only text would be D81's "You have a new item in Shri
  Health".

Nothing here logs a title, a body, a reply or a reason.
"""
from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

from pydantic.alias_generators import to_camel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.access import ChartAccess
from app.core.deps import CurrentUser
from app.core.errors import (
    AppError,
    Conflict,
    Forbidden,
    InternalError,
    NotFound,
    PreconditionFailed,
    PreconditionRequired,
    ValidationFailed,
    field_error,
)
from app.core.events import ROLE
from app.core.permissions import roles_allow

from ..history.service import decode_cursor, encode_cursor
from . import schemas as s
from .repository import (
    OPEN_STATUSES,
    PRIORITY_STORED,
    SUBJECTS,
    EventRow,
    InboxStore,
    ItemRow,
    NewItem,
    PatientRow,
    Refused,
    ReplyRow,
    Scope,
    priority_code,
)

PAGE_MAX = 100
THREAD_MAX = 500
ADM = "ADM"
PATIENT_MESSAGE = "patient-message"
RESTRICTED_TITLE = "Item about a restricted chart"
ASSIGNED = "inbox.item-assigned"
COMPLETED = "inbox.item-completed"

#: The read permission each kind needs (BATCH3_PLAN §5 rule 3). A kind not listed is never shown.
#: `rooming` isn't in §5: it is read with `encounters:read`, as the rooming screen's visit.
KIND_PERMISSION: dict[str, str] = {
    "message": "inbox:read", "task": "inbox:read", PATIENT_MESSAGE: "inbox:read",
    "result-review": "results:read", "unmatched-result": "unmatched-results:read",
    "refill-request": "refill-requests:read", "prescription-failure": "prescriptions:read",
    "cosign": "notes:read", "cosign-returned": "notes:read", "unsigned-note": "notes:read",
    "fax-indexing": "fax-inbox:read", "document-review": "documents:read",
    "claim-rejection": "claims:read", "eligibility": "eligibility-checks:read",
    "break-glass-review": "audit-events:read", "rooming": "encounters:read",
}
#: Kinds that their own action completes (Q4), and that action, for the 422's detail.
COMPLETED_BY_ACTION: dict[str, str] = {
    "cosign": "co-signing the note", "cosign-returned": "the author's addendum",
    "unsigned-note": "signing the note", "fax-indexing": "filing the fax",
    "result-review": "acknowledging the result",
    "refill-request": "responding to the refill request",
    "unmatched-result": "matching or rejecting the result",
}
CANCELLABLE = frozenset({"message", "task", PATIENT_MESSAGE})
HANDED_BACK = frozenset({"message", "task"})
FREE_TEXT_TITLES = frozenset({"message", "task", PATIENT_MESSAGE})
_ASSIGNMENTS = ("created", "assigned", "escalated")
_RANK = {"created": 0, "comment": 1}  # same-instant order: created, the reply, then the rest

#: core.access.chart_access: how the user may open a chart, without refusing or auditing.
ChartView = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[ChartAccess]]
#: core.access.ensure_chart_access: 404, or 403 break-glass-required (audited).
ChartCheck = Callable[[AsyncSession, CurrentUser, UUID], Awaitable[ChartAccess]]
#: core.events.publish.
Publish = Callable[..., Awaitable[Any]]


# ------------------------------------------------------------------------------------ helpers
def etag(version: int) -> str:
    return f'"{version}"'


def if_match_version(header: str | None) -> int:
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if value.startswith('"') and value.endswith('"') and value[1:-1].isdigit():
        return int(value[1:-1])
    raise PreconditionFailed()  # a weak or malformed tag never matches a strong one


def _rule(where: str, code: str, detail: str | None = None) -> ValidationFailed:
    return ValidationFailed(detail, code="business-rule-violation",
                            errors=[field_error("body", where, code)])


def _invalid(where: str, code: str, location: str = "body") -> ValidationFailed:
    return ValidationFailed(errors=[field_error(location, where, code)])


def readable_kinds(user: CurrentUser) -> list[str]:
    return sorted(k for k, permission in KIND_PERMISSION.items() if user.can(permission))


def visible(user: CurrentUser) -> Scope:
    """Every item the user may see (BATCH3_PLAN §5), whatever the view."""
    return Scope(me=user.id, roles=sorted(user.roles), facilities=sorted(user.facility_ids),
                 kinds=readable_kinds(user), adm=ADM in user.roles)


def _holds(user: CurrentUser, row: ItemRow) -> bool:
    """The item is with the user: assigned to them, or to a role of theirs."""
    return row.assigned_user_id == user.id or (
        row.assigned_role_code is not None and row.assigned_role_code in user.roles)


def _sees(user: CurrentUser, row: ItemRow) -> bool:
    """``visible``'s last rule for an item already at the user's facilities and kinds."""
    return (_holds(user, row) or row.created_by_user_id == user.id or ADM in user.roles)


def _now() -> datetime:
    return datetime.now(UTC)


# ------------------------------------------------------------------------------ read models
def _staff(user_id: UUID, name: str | None) -> s.StaffRef:
    return s.StaffRef(id=user_id, display_name=(name or "Unnamed user")[:200])


def _assignee(row: ItemRow) -> s.Assignee | None:
    if row.assigned_user_id is not None:
        return s.Assignee(type="user", id=row.assigned_user_id,
                          display_name=(row.assigned_user_name or "Unnamed user")[:200])
    if row.assigned_role_id is not None:
        return s.Assignee(type="role", id=row.assigned_role_id,
                          display_name=(row.assigned_role_name or row.assigned_role_code
                                        or "Role")[:200])
    return None


def to_patient(found: PatientRow) -> s.InboxPatient:
    family = (found.family or found.text or "Unknown")[:100]
    return s.InboxPatient(
        id=found.id, birth_date=found.birth_date,
        name=s.HumanName(given=[g[:100] for g in (found.given or [])][:5], family=family,
                         prefix=found.prefix[0][:20] if found.prefix else None,
                         suffix=found.suffix[0][:20] if found.suffix else None))


def thread_of(row: ItemRow, events: Sequence[EventRow], replies: Sequence[ReplyRow], *,
              open_chart: bool) -> list[s.ThreadEvent]:
    """The item's events and replies, oldest first, at most 500. ``work_item_event`` keeps a
    user assignee only, so a role appears on the last assignment, the one the item still has."""
    last = max((i for i, e in enumerate(events) if e.event in _ASSIGNMENTS), default=None)
    entries: list[tuple[datetime, int, int, s.ThreadEvent]] = []
    for i, e in enumerate(events):
        assignee = None
        if e.assigned_user_id is not None:
            assignee = s.Assignee(type="user", id=e.assigned_user_id,
                                  display_name=(e.assigned_name or "Unnamed user")[:200])
        elif i == last and row.assigned_role_id is not None:
            assignee = _assignee(row)
        entries.append((e.occurred_at, _RANK.get(e.event, 2), len(entries), s.ThreadEvent(
            event=e.event, at=e.occurred_at,
            by=_staff(e.user_id, e.user_name) if e.user_id is not None else None,
            from_status=e.from_status, to_status=e.to_status,
            assignee=assignee, comment=e.comment if open_chart else None)))
    for r in replies:
        entries.append((r.created_at, _RANK["comment"], len(entries), s.ThreadEvent(
            event="comment", at=r.created_at,
            by=(_staff(r.author_user_id, r.author_name)
                if r.author_user_id is not None else None),
            comment=r.body if open_chart else None,
            from_patient=True if r.from_patient else None,
            to_patient=True if r.to_patient and not r.from_patient else None)))
    entries.sort(key=lambda entry: entry[:3])
    return [entry[3] for entry in entries[:THREAD_MAX]]


def to_item(row: ItemRow, *, open_chart: bool, patient: PatientRow | None = None,
            thread: list[s.ThreadEvent] | None = None) -> s.InboxItem:
    """One item as the user may see it (D37: a chart they may not open shows nothing of it)."""
    restricted = row.patient_id is not None and not open_chart
    title = RESTRICTED_TITLE if restricted and row.item_type in FREE_TEXT_TITLES else row.title
    closed_at = row.completed_at if row.status == "completed" else (
        row.updated_at if row.status == "cancelled" else None)  # a closed item never changes
    return s.InboxItem(
        id=row.id, item_type=row.item_type, status=row.status,
        priority=priority_code(row.priority), title=title,
        body=None if restricted else row.body, assignee=_assignee(row),
        facility_id=row.facility_id, due_at=row.due_at, overdue=row.overdue,
        escalation_level=min(row.escalation_level, 9), escalated_at=row.escalated_at,
        restricted=restricted,
        patient=to_patient(patient) if patient is not None and not restricted else None,
        subject=(s.Subject(type=row.subject_type, id=row.subject_id)
                 if row.subject_type is not None and row.subject_id is not None else None),
        encounter_id=None if restricted else row.encounter_id,
        created_by=(_staff(row.created_by_user_id, row.created_by_name)
                    if row.created_by_user_id is not None
                    and row.item_type != PATIENT_MESSAGE else None),
        created_at=row.created_at, updated_at=row.updated_at, completed_at=closed_at,
        completed_by=(_staff(row.completed_by_user_id, row.completed_by_name)
                      if row.completed_by_user_id is not None and closed_at is not None
                      else None),
        thread=thread)


async def _opened(db: AsyncSession, view: ChartView, user: CurrentUser,
                  patients: Iterable[UUID | None]) -> set[UUID]:
    """The charts among these the user may open (D37); reads only, audits nothing."""
    found = set()
    for patient_id in dict.fromkeys(p for p in patients if p is not None):
        if (await view(db, user, patient_id)).allowed:
            found.add(patient_id)
    return found


@dataclass(frozen=True)
class Shown:
    """An item as returned, its ETag version, and the patients to audit."""

    item: s.InboxItem
    version: int
    patients: list[UUID]  # the charts shown, for a read's audit row
    patient_id: UUID | None = None  # the item's patient, for a write's

    @property
    def written(self) -> list[UUID]:
        return [self.patient_id] if self.patient_id is not None else []


async def _show(db: AsyncSession, store: InboxStore, view: ChartView, user: CurrentUser,
                row: ItemRow) -> Shown:
    opened = await _opened(db, view, user, [row.patient_id])
    open_chart = row.patient_id in opened
    found = await store.patients(db, opened)
    thread = thread_of(row, await store.events(db, row.id), await store.replies(db, row.id),
                       open_chart=open_chart)
    item = to_item(row, open_chart=open_chart,
                   patient=found.get(row.patient_id) if row.patient_id else None, thread=thread)
    return Shown(item, row.version, sorted(opened), row.patient_id)


async def _reread(db: AsyncSession, store: InboxStore, view: ChartView, user: CurrentUser,
                  item_id: UUID) -> Shown:
    """After a change: the item at the user's facilities and kinds even when it has left their
    hands (handed back, reassigned), since they just acted on it."""
    row = await store.item(db, replace(visible(user), adm=True), item_id)
    if row is None:  # pragma: no cover - written in this transaction
        raise InternalError()
    return await _show(db, store, view, user, row)


# ---------------------------------------------------------------------------------- reads
async def list_items(db: AsyncSession, store: InboxStore, view: ChartView, check: ChartCheck,
                     user: CurrentUser, *, view_name: str = "assigned",
                     item_types: Sequence[str] = (), statuses: Sequence[str] = (),
                     priorities: Sequence[str] = (), patient_id: UUID | None = None,
                     facility_id: UUID | None = None, due_before: datetime | None = None,
                     limit: int = 25, cursor: str | None = None
                     ) -> tuple[s.InboxItemList, list[UUID]]:
    """One page, and the patients on it the user may open (for the audit row)."""
    offset = decode_cursor(cursor)
    if view_name == "facility" and ADM not in user.roles:
        raise ValidationFailed(code="business-rule-violation",
                               errors=[field_error("query", "view", "not-allowed-value")])
    if patient_id is not None and await view(db, user, patient_id) is ChartAccess.BLOCKED:
        await check(db, user, patient_id)  # 403 break-glass-required, audited with the patient
    scope = visible(user)
    kinds = [k for k in scope.kinds if not item_types or k in item_types]
    facilities = [f for f in scope.facilities if facility_id is None or f == facility_id]
    size = min(limit, PAGE_MAX)
    rows = await store.items(db, replace(
        scope, view=view_name, kinds=kinds, facilities=facilities,
        statuses=list(dict.fromkeys(statuses)) or list(OPEN_STATUSES),
        priorities=sorted({PRIORITY_STORED[p] for p in priorities}) or None,
        patient=patient_id, due_before=due_before), limit=size + 1, offset=offset)
    page = rows[:size]
    opened = await _opened(db, view, user, (r.patient_id for r in page))
    found = await store.patients(db, opened)
    items = [to_item(r, open_chart=r.patient_id in opened,
                     patient=found.get(r.patient_id) if r.patient_id else None) for r in page]
    return (s.InboxItemList(items=items,
                            next_cursor=encode_cursor(offset + size) if len(rows) > size
                            else None),
            sorted(opened))


async def summary(db: AsyncSession, store: InboxStore, user: CurrentUser) -> s.InboxSummary:
    rows = await store.summary(db, visible(user))
    by_type = [s.TypeCount(item_type=r.item_type, open=r.open, in_progress=r.in_progress,
                           on_hold=r.on_hold, overdue=r.overdue) for r in rows]
    return s.InboxSummary(total=sum(t.open + t.in_progress + t.on_hold for t in by_type),
                          overdue=sum(t.overdue for t in by_type), by_type=by_type[:40])


async def get_item(db: AsyncSession, store: InboxStore, view: ChartView, user: CurrentUser,
                   item_id: UUID) -> Shown:
    row = await store.item(db, visible(user), item_id)
    if row is None:
        raise NotFound()
    return await _show(db, store, view, user, row)


# ---------------------------------------------------------------------------- assignments
@dataclass(frozen=True)
class Target:
    user_id: UUID | None
    role_id: UUID | None
    role_code: str | None


async def _target(db: AsyncSession, store: InboxStore, facility_id: UUID, kind: str,
                  wanted: s.AssigneeInput, missing: AppError) -> Target:
    """A new assignee: an active user who works at the facility, or a role, either able to read
    the kind; ``missing`` for one the clinic doesn't have, else 422 ``/assignee``."""
    permission = KIND_PERMISSION.get(kind)
    if wanted.type == "user":
        staff = await store.staff(db, wanted.id, facility_id)
        if staff is None:
            raise missing
        if (not staff.is_active or not staff.codes or permission is None
                or not roles_allow(staff.codes, permission)):
            raise _rule("/assignee", "invalid-reference")
        return Target(wanted.id, None, None)
    role = await store.role(db, wanted.id)
    if role is None:
        raise missing
    if permission is None or not roles_allow([role.code], permission):
        raise _rule("/assignee", "invalid-reference")
    return Target(None, role.id, role.code)


async def _announce(db: AsyncSession, publish: Publish, item_id: UUID, kind: str, priority: str,
                    facility_id: UUID, patient_id: UUID | None, target: Target) -> None:
    """``inbox.item-assigned`` for the new assignee: the kind and the priority only (D81)."""
    role = target.role_code if target.role_code and ROLE.fullmatch(target.role_code) else None
    if target.user_id is None and role is None:
        return  # a clinic role without a standard code: nobody to address it to
    await publish(db, ASSIGNED, f"inbox-item/{item_id}",
                  {"itemType": kind, "priority": priority},
                  facility_id=facility_id, patient_id=patient_id,
                  target_user_id=target.user_id, target_role_code=role)


async def _announce_closed(db: AsyncSession, publish: Publish, row: ItemRow, status: str) -> None:
    """``inbox.item-completed`` for the holder's screens and the sender's ``sent`` view."""
    data = {"itemType": row.item_type, "status": status}
    subject = f"inbox-item/{row.id}"
    role = (row.assigned_role_code if row.assigned_role_code
            and ROLE.fullmatch(row.assigned_role_code) else None)
    if row.assigned_user_id is not None or role is not None:
        await publish(db, COMPLETED, subject, data, facility_id=row.facility_id,
                      patient_id=row.patient_id, target_user_id=row.assigned_user_id,
                      target_role_code=role)
    if row.created_by_user_id is not None and row.created_by_user_id != row.assigned_user_id:
        await publish(db, COMPLETED, subject, data, facility_id=row.facility_id,
                      patient_id=row.patient_id, target_user_id=row.created_by_user_id)


async def _locked(db: AsyncSession, store: InboxStore, user: CurrentUser,
                  item_id: UUID) -> ItemRow:
    row = await store.item(db, visible(user), item_id, lock=True)
    if row is None:
        raise NotFound()
    return row


def _still_open(row: ItemRow) -> None:
    if row.closed:
        raise Conflict(code="invalid-state-transition", currentState=row.status)


# ---------------------------------------------------------------------------------- writes
async def create_message(db: AsyncSession, store: InboxStore, view: ChartView,
                         check: ChartCheck, publish: Publish, user: CurrentUser,
                         body: s.MessageCreate) -> Shown:
    """A message or a task for one user or one role (#217), in the caller's transaction."""
    if body.facility_id not in user.facility_ids:
        raise _rule("/facilityId", "not-allowed-value")
    if not body.title.strip():
        raise _invalid("/title", "required")
    if body.due_at is not None and body.kind == "message":
        raise _rule("/dueAt", "not-allowed-value")
    if body.due_at is not None and body.due_at <= _now():
        raise _rule("/dueAt", "out-of-range")
    if body.patient_id is not None:
        await check(db, user, body.patient_id)  # 404, or 403 break-glass-required (D37)
        if await store.merged_into(db, body.patient_id) is not None:
            raise Conflict(code="patient-merged")
    if body.subject is not None:
        kind = SUBJECTS.get(body.subject.type)
        if kind is None:
            raise _invalid("/subject/type", "not-allowed-value")
        if not user.can(kind.permission):
            raise NotFound()  # the sender must be able to open the record (D80)
        exists, owner = await store.subject_patient(db, kind, body.subject.id)
        if not exists:
            raise NotFound()
        if owner != body.patient_id:
            raise _rule("/subject", "conflicting-fields")
    target = await _target(db, store, body.facility_id, body.kind, body.assignee, NotFound())
    item_id = await store.create(db, NewItem(
        tenant_id=user.organization_id, kind=body.kind, priority=PRIORITY_STORED[body.priority],
        title=body.title, body=body.body, facility_id=body.facility_id,
        assigned_user_id=target.user_id, assigned_role_id=target.role_id, due_at=body.due_at,
        patient_id=body.patient_id,
        subject_type=body.subject.type if body.subject else None,
        subject_id=body.subject.id if body.subject else None, created_by=user.id))
    await store.add_event(db, user.organization_id, item_id, "created", me=user.id,
                          to_status="open", assigned_user_id=target.user_id)
    await _announce(db, publish, item_id, body.kind, body.priority, body.facility_id,
                    body.patient_id, target)
    return await _reread(db, store, view, user, item_id)


async def update_item(db: AsyncSession, store: InboxStore, view: ChartView, publish: Publish,
                      user: CurrentUser, item_id: UUID, body: s.InboxItemPatch,
                      if_match: str | None) -> Shown:
    """Take, reassign, change the status, priority or due time (#215), with If-Match."""
    sent = body.model_fields_set
    if not sent:
        raise _invalid("", "required")
    for name in ("assignee", "status", "priority"):
        if name in sent and getattr(body, name) is None:
            raise _invalid(f"/{to_camel(name)}", "invalid-type")
    expected = if_match_version(if_match)
    # The version is compared before who has the item, so that a colleague who took it from the
    # queue first makes the slower one's If-Match fail (412, DATA_OWNERSHIP §5.9) rather than
    # hiding it (404). Only an item at the user's facilities, of a kind they read, answers so.
    row = await store.item(db, replace(visible(user), adm=True), item_id, lock=True)
    if row is None:
        raise NotFound()
    if expected != row.version:
        raise PreconditionFailed(headers={"ETag": etag(row.version)} if _sees(user, row)
                                 else None)
    if not _sees(user, row):
        raise NotFound()
    _still_open(row)
    # Who may change what (403).
    new = body.assignee if "assignee" in sent else None
    if new is not None:
        taking = (new.type == "user" and new.id == user.id and row.assigned_user_id is None
                  and _holds(user, row))
        if not (row.assigned_user_id == user.id or taking or ADM in user.roles):
            raise Forbidden("Only the assignee or an administrator reassigns an item")
    if sent & {"priority", "due_at"} and not (
            _holds(user, row) or row.created_by_user_id == user.id):
        raise Forbidden("Only the assignee or the sender changes the priority or due time")
    # The rules (422).
    moved = new is not None and not (
        (new.type == "user" and new.id == row.assigned_user_id)
        or (new.type == "role" and new.id == row.assigned_role_id))
    target = (await _target(db, store, row.facility_id, row.item_type, new,
                            _rule("/assignee", "invalid-reference"))
              if new is not None and moved else None)
    holder_after = target.user_id if target is not None else row.assigned_user_id
    status_changes = body.status is not None and body.status != row.status
    if status_changes and holder_after != user.id:
        raise _rule("/status", "not-allowed-value")
    if body.due_at is not None and body.due_at <= _now():
        raise _rule("/dueAt", "out-of-range")
    # The change, its thread events and its event.
    changes: dict[str, Any] = {}
    if target is not None:
        changes |= {"assigned_user_id": target.user_id, "assigned_role_id": target.role_id}
        await store.add_event(db, user.organization_id, row.id, "assigned", me=user.id,
                              assigned_user_id=target.user_id)
    if status_changes:
        changes["status"] = body.status
        await store.add_event(db, user.organization_id, row.id, "status-change", me=user.id,
                              from_status=row.status, to_status=body.status)
    priority = body.priority or priority_code(row.priority)
    if body.priority is not None and PRIORITY_STORED[body.priority] != row.priority:
        changes["priority"] = PRIORITY_STORED[body.priority]
    if "due_at" in sent and body.due_at != row.due_at:
        changes["due_at"] = body.due_at
    if changes:
        await store.update(db, row.id, user.id, changes)
    if target is not None:
        await _announce(db, publish, row.id, row.item_type, priority, row.facility_id,
                        row.patient_id, target)
    return await _reread(db, store, view, user, row.id)


async def complete_item(db: AsyncSession, store: InboxStore, view: ChartView, publish: Publish,
                        user: CurrentUser, item_id: UUID, body: s.CompleteRequest | None
                        ) -> Shown:
    """Marks the item done (#216), in the caller's transaction."""
    row = await _locked(db, store, user, item_id)
    _still_open(row)
    action = COMPLETED_BY_ACTION.get(row.item_type)
    if action is not None:
        raise _rule("/itemType", "not-allowed-value", f"This item is completed by {action}")
    allowed = (_holds(user, row) if row.item_type == PATIENT_MESSAGE
               else row.assigned_user_id == user.id)
    if not allowed:
        raise Forbidden("Only the assignee completes an item")
    comment = (body.comment or "").strip() or None if body is not None else None
    await store.update(db, row.id, user.id, {"status": "completed",
                                             "completed_by_user_id": user.id},
                       completed_now=True)
    await store.add_event(db, user.organization_id, row.id, "status-change", me=user.id,
                          from_status=row.status, to_status="completed", comment=comment)
    await _announce_closed(db, publish, row, "completed")
    return await _reread(db, store, view, user, row.id)


async def cancel_item(db: AsyncSession, store: InboxStore, view: ChartView, publish: Publish,
                      user: CurrentUser, item_id: UUID, body: s.CancelRequest) -> Shown:
    """Closes a message or task sent by mistake, with the reason in the thread (#253)."""
    row = await _locked(db, store, user, item_id)
    _still_open(row)
    if row.item_type not in CANCELLABLE:
        raise _rule("/itemType", "not-allowed-value")
    allowed = (_holds(user, row) if row.item_type == PATIENT_MESSAGE
               else row.created_by_user_id == user.id)
    if not allowed:
        raise Forbidden("Only the sender cancels a message or task")
    reason = body.reason.strip()
    if not reason:
        raise _invalid("/reason", "required")
    await store.update(db, row.id, user.id, {"status": "cancelled",
                                             "completed_by_user_id": user.id})
    await store.add_event(db, user.organization_id, row.id, "status-change", me=user.id,
                          from_status=row.status, to_status="cancelled", comment=reason)
    await _announce_closed(db, publish, row, "cancelled")
    return await _reread(db, store, view, user, row.id)


def hand_back_to(user: CurrentUser, row: ItemRow, events: Sequence[EventRow]) -> UUID | None:
    """Who a reply hands a message or task to (``assignBack``): the sender when the item's
    holder replies; when the sender replies to an item that is with them, the last other user
    it was with (or who handed it to them). Anyone else's reply moves nothing."""
    sender = row.created_by_user_id
    if sender is None or row.item_type not in HANDED_BACK:
        return None
    if user.id == sender:
        if row.assigned_user_id != sender:
            return None  # already with the other party
        for e in reversed(events):
            if e.event in _ASSIGNMENTS and e.assigned_user_id not in (None, sender):
                return e.assigned_user_id
        for e in reversed(events):
            if e.event == "assigned" and e.user_id not in (None, sender):
                return e.user_id
        return None
    if _holds(user, row) and row.assigned_user_id != sender:
        return sender
    return None


async def reply(db: AsyncSession, store: InboxStore, view: ChartView, check: ChartCheck,
                publish: Publish, user: CurrentUser, item_id: UUID, body: s.ReplyRequest
                ) -> Shown:
    """A reply on the item's thread (#254), and the hand-back, in the caller's transaction."""
    row = await _locked(db, store, user, item_id)
    if body.to_patient and row.item_type != PATIENT_MESSAGE:
        raise _invalid("/toPatient", "not-allowed-value")
    if body.to_patient and row.patient_id is not None:
        await check(db, user, row.patient_id)  # 403 break-glass-required (D37)
    _still_open(row)
    if not body.text.strip():
        raise _invalid("/text", "required")
    try:
        await store.reply(db, row.id, body.text, body.to_patient)
    except Refused as refused:
        raise _refusal(refused.reason, row) from None
    if body.assign_back:
        to = hand_back_to(user, row, await store.events(db, row.id))
        if to is not None:
            try:
                target = await _target(db, store, row.facility_id, row.item_type,
                                       s.AssigneeInput(type="user", id=to), NotFound())
            except AppError:
                target = None  # they can no longer take it: the reply stays, the item too
            if target is not None:
                await store.update(db, row.id, user.id, {"assigned_user_id": to,
                                                         "assigned_role_id": None})
                await store.add_event(db, user.organization_id, row.id, "assigned",
                                      me=user.id, assigned_user_id=to)
                await _announce(db, publish, row.id, row.item_type,
                                priority_code(row.priority), row.facility_id, row.patient_id,
                                target)
    return await _reread(db, store, view, user, row.id)


def _refusal(reason: str, row: ItemRow) -> AppError:
    match reason:
        case "not-found":
            return NotFound()
        case "inbox_item_closed":
            return Conflict(code="invalid-state-transition", currentState=row.status)
        case "inbox_reply_to_patient_not_allowed":
            return _invalid("/toPatient", "not-allowed-value")
        case "inbox_reply_not_staff":
            return Forbidden()
        case _:  # pragma: no cover - 0031 raises no other
            return InternalError()
