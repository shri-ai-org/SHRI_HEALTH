"""The inbox's data: ``admin.work_item`` and ``admin.work_item_event`` through shri_app's table
grants, and replies only through migration 0031's functions (``admin.inbox_reply`` and
``admin.inbox_replies``; shri_app has no privilege on ``work_item_reply``). Every query runs in
the request's clinic session (row-level security); the service decides who sees what and passes
it in as a ``Scope``. Nothing here logs a title, a body or a reply.

How contract shapes are stored (also in docs/contract_mapping.yaml, "Inbox, messages"):

- ``priority`` is ``work_item.priority`` (smallint 1..5): ``stat`` 1, ``asap`` 2, ``urgent`` 3,
  ``routine`` 4 (BATCH3_PLAN Q3; 5 is unused and read as ``routine``). ``PRIORITY_STORED`` is
  the only copy of the mapping.
- ``subject`` is whichever one of the item's nine record columns is set (``SUBJECTS``).
- The ``ETag`` is ``updated_at`` in microseconds: ``work_item`` has no version column (BATCH3
  S1), and every change here, the replies' function and the portal's reply all set it, under the
  row's lock.
- A thread event's time is ``clock_timestamp()``, so the events one request writes keep their
  order.
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID, uuid4

from sqlalchemy import TextClause, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import fhir_store as fs
from app.db.errors import db_error_detail

#: The contract's priority as stored in work_item.priority (Q3). The one copy of the mapping.
PRIORITY_STORED: dict[str, int] = {"stat": 1, "asap": 2, "urgent": 3, "routine": 4}
_PRIORITY_CODE = {stored: code for code, stored in PRIORITY_STORED.items()}

OPEN_STATUSES = ("open", "in-progress", "on-hold")
CLOSED_STATUSES = ("completed", "cancelled")


def priority_code(stored: int) -> str:
    return _PRIORITY_CODE.get(stored, "routine")


@dataclass(frozen=True)
class SubjectKind:
    column: str  # work_item's column
    table: str  # the record's table, schema-qualified
    patient_column: str | None  # the record's patient, if it has one
    permission: str  # what the sender needs to open it (D80)


#: The contract's InboxSubject.type, and where each kind of record lives.
SUBJECTS: dict[str, SubjectKind] = {
    "result": SubjectKind("diagnostic_report_id", "clinical.diagnostic_report",
                          "subject_patient_id", "results:read"),
    "note": SubjectKind("composition_id", "clinical.composition", "subject_patient_id",
                        "notes:read"),
    "document": SubjectKind("document_reference_id", "clinical.document_reference",
                            "subject_patient_id", "documents:read"),
    "prescription": SubjectKind("medication_request_id", "clinical.medication_request",
                                "subject_patient_id", "prescriptions:read"),
    "order": SubjectKind("service_request_id", "clinical.service_request", "subject_patient_id",
                         "orders:read"),
    "appointment": SubjectKind("appointment_id", "clinical.appointment", "subject_patient_id",
                               "appointments:read"),
    "unmatched-result": SubjectKind("unmatched_result_id", "admin.unmatched_result", None,
                                    "unmatched-results:read"),
    "claim": SubjectKind("claim_id", "admin.claim", "patient_id", "claims:read"),
    "fax": SubjectKind("fax_transmission_id", "admin.fax_transmission", None, "fax-inbox:read"),
}

_SUBJECT_TYPE = "CASE " + " ".join(
    f"WHEN w.{k.column} IS NOT NULL THEN '{name}'" for name, k in SUBJECTS.items()) + " END"
_SUBJECT_ID = "coalesce(" + ", ".join(f"w.{k.column}" for k in SUBJECTS.values()) + ")"

_ITEM = f"""
SELECT w.id, w.item_type, w.status, w.priority, w.title, w.body,
       w.assigned_user_id, au.display_name AS assigned_user_name,
       w.assigned_role_id, r.code AS assigned_role_code, r.name AS assigned_role_name,
       w.facility_id, w.due_at, w.escalation_level, w.escalated_at,
       w.completed_at, w.completed_by_user_id, cu.display_name AS completed_by_name,
       w.patient_id, w.encounter_id,
       {_SUBJECT_TYPE} AS subject_type, {_SUBJECT_ID} AS subject_id,
       w.created_by_user_id, cb.display_name AS created_by_name, w.created_at, w.updated_at,
       coalesce(w.due_at < now() AND w.status IN ('open', 'in-progress', 'on-hold'), false)
         AS overdue
  FROM admin.work_item w
  LEFT JOIN admin.app_user au ON au.id = w.assigned_user_id
  LEFT JOIN admin.role r ON r.id = w.assigned_role_id
  LEFT JOIN admin.app_user cu ON cu.id = w.completed_by_user_id
  LEFT JOIN admin.app_user cb ON cb.id = w.created_by_user_id
"""  # noqa: S608 (the fragments are this file's constants)

# Who may see an item at all (BATCH3_PLAN §5): one of the user's facilities, a kind the user may
# read, and the user's own item, a role queue of theirs, one they sent, or (ADM) any item there.
_VISIBLE = """
 w.facility_id = ANY(CAST(:facilities AS uuid[]))
 AND w.item_type = ANY(CAST(:kinds AS varchar[]))
 AND (w.assigned_user_id = CAST(:me AS uuid) OR r.code = ANY(CAST(:roles AS varchar[]))
      OR w.created_by_user_id = CAST(:me AS uuid) OR CAST(:adm AS boolean))"""

_VIEWS: dict[str, str] = {
    "assigned": "(w.assigned_user_id = CAST(:me AS uuid) "
                "OR r.code = ANY(CAST(:roles AS varchar[])))",
    "mine": "w.assigned_user_id = CAST(:me AS uuid)",
    "queue": "r.code = ANY(CAST(:roles AS varchar[]))",
    "sent": "w.created_by_user_id = CAST(:me AS uuid)",
    "facility": "true",
}

_FILTERS = """
 AND w.status = ANY(CAST(:statuses AS varchar[]))
 AND (CAST(:priorities AS int[]) IS NULL OR w.priority = ANY(CAST(:priorities AS int[])))
 AND (CAST(:patient AS uuid) IS NULL OR w.patient_id = CAST(:patient AS uuid))
 AND (CAST(:due_before AS timestamptz) IS NULL OR w.due_at < CAST(:due_before AS timestamptz))"""

# Highest priority first, then overdue, then by due time, then oldest (InboxItemList).
_ORDER = """
 ORDER BY w.priority, coalesce(w.due_at < now()
          AND w.status IN ('open', 'in-progress', 'on-hold'), false) DESC,
          w.due_at NULLS LAST, w.created_at, w.id
 LIMIT :limit OFFSET :offset"""

_SUMMARY = text(f"""
SELECT w.item_type,
       count(*) FILTER (WHERE w.status = 'open') AS open,
       count(*) FILTER (WHERE w.status = 'in-progress') AS in_progress,
       count(*) FILTER (WHERE w.status = 'on-hold') AS on_hold,
       count(*) FILTER (WHERE w.due_at < now()) AS overdue
  FROM admin.work_item w LEFT JOIN admin.role r ON r.id = w.assigned_role_id
 WHERE {_VISIBLE} AND {_VIEWS["assigned"]}
   AND w.status IN ('open', 'in-progress', 'on-hold')
 GROUP BY w.item_type ORDER BY w.item_type
""")  # noqa: S608

_EVENTS = text("""
SELECT e.event, e.from_status, e.to_status, e.assigned_user_id, au.display_name AS assigned_name,
       e.comment, e.occurred_at, e.user_id, u.display_name AS user_name
  FROM admin.work_item_event e
  LEFT JOIN admin.app_user au ON au.id = e.assigned_user_id
  LEFT JOIN admin.app_user u ON u.id = e.user_id
 WHERE e.work_item_id = :item
 ORDER BY e.occurred_at, e.created_at, e.id
 LIMIT 500
""")
_REPLIES = text("SELECT * FROM admin.inbox_replies(:item)")
_REPLY = text("SELECT admin.inbox_reply(:item, :body, :to_patient)")

_PATIENTS = text("""
SELECT p.id, p.birth_date, n.family, n.given, n.prefix, n.suffix, n.text
  FROM clinical.patient p
  LEFT JOIN LATERAL (SELECT h.family, h.given, h.prefix, h.suffix, h.text
                       FROM clinical.human_name h WHERE h.patient_id = p.id
                      ORDER BY (h.use = 'official') DESC, h.created_at, h.id LIMIT 1) n ON true
 WHERE p.id = ANY(CAST(:ids AS uuid[]))
""")

# A staff user and the role codes they hold at one facility today (a role with no facility
# covers every facility, as core's sign-in reads it).
_STAFF = text("""
SELECT u.id, u.is_active, u.display_name,
       coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS codes
  FROM admin.app_user u
  LEFT JOIN admin.user_role ur ON ur.user_id = u.id
        AND (ur.facility_id IS NULL OR ur.facility_id = :facility)
        AND (ur.valid_from IS NULL OR ur.valid_from <= current_date)
        AND (ur.valid_to IS NULL OR ur.valid_to >= current_date)
  LEFT JOIN admin.role r ON r.id = ur.role_id
 WHERE u.id = :user
 GROUP BY u.id, u.is_active, u.display_name
""")
_ROLE = text("SELECT id, code, name FROM admin.role WHERE id = :role")

_CREATE = text(f"""
INSERT INTO admin.work_item (id, tenant_id, item_type, status, priority, title, body,
                             assigned_user_id, assigned_role_id, facility_id, due_at,
                             escalation_level, patient_id, {", ".join(k.column for k in
                                                                      SUBJECTS.values())},
                             created_by_user_id, updated_by_user_id)
VALUES (:id, :tenant, :kind, 'open', :priority, :title, :body, :user, :role, :facility,
        :due_at, 0, :patient, {", ".join(f":{k.column}" for k in SUBJECTS.values())},
        :me, :me)
""")  # noqa: S608
_EVENT = text("""
INSERT INTO admin.work_item_event (id, tenant_id, work_item_id, event, from_status, to_status,
                                   assigned_user_id, comment, occurred_at, user_id,
                                   created_by_user_id)
VALUES (gen_random_uuid(), :tenant, :item, :event, :from_status, :to_status, :assigned, :comment,
        clock_timestamp(), :me, :me)
""")

#: The work_item columns update() may set.
UPDATABLE = frozenset({"assigned_user_id", "assigned_role_id", "status", "priority", "due_at",
                       "completed_by_user_id"})

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


def version_of(updated_at: datetime) -> int:
    """The ETag's value: ``updated_at`` in whole microseconds, exactly."""
    return (updated_at - _EPOCH) // timedelta(microseconds=1)


class Refused(Exception):
    """``admin.inbox_reply``'s refusal: its constraint name, or ``not-found`` (P0002)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Scope:
    """What the user may see, and the list's view and filters (the service builds it)."""

    me: UUID
    roles: Sequence[str]
    facilities: Sequence[UUID]
    kinds: Sequence[str]
    adm: bool = False
    view: str = "assigned"
    statuses: Sequence[str] = OPEN_STATUSES
    priorities: Sequence[int] | None = None
    patient: UUID | None = None
    due_before: datetime | None = None

    def params(self) -> dict[str, Any]:
        return {"me": self.me, "roles": list(self.roles), "facilities": list(self.facilities),
                "kinds": list(self.kinds), "adm": self.adm, "statuses": list(self.statuses),
                "priorities": list(self.priorities) if self.priorities is not None else None,
                "patient": self.patient, "due_before": self.due_before}


@dataclass(frozen=True)
class ItemRow:
    id: UUID
    item_type: str
    status: str
    priority: int
    title: str
    body: str | None
    assigned_user_id: UUID | None
    assigned_user_name: str | None
    assigned_role_id: UUID | None
    assigned_role_code: str | None
    assigned_role_name: str | None
    facility_id: UUID
    due_at: datetime | None
    escalation_level: int
    escalated_at: datetime | None
    completed_at: datetime | None
    completed_by_user_id: UUID | None
    completed_by_name: str | None
    patient_id: UUID | None
    encounter_id: UUID | None
    subject_type: str | None
    subject_id: UUID | None
    created_by_user_id: UUID | None
    created_by_name: str | None
    created_at: datetime
    updated_at: datetime
    overdue: bool

    @property
    def version(self) -> int:
        return version_of(self.updated_at)

    @property
    def closed(self) -> bool:
        return self.status in CLOSED_STATUSES


@dataclass(frozen=True)
class EventRow:
    event: str
    from_status: str | None
    to_status: str | None
    assigned_user_id: UUID | None
    assigned_name: str | None
    comment: str | None
    occurred_at: datetime
    user_id: UUID | None
    user_name: str | None


@dataclass(frozen=True)
class ReplyRow:
    id: UUID
    author_user_id: UUID | None
    author_name: str | None
    from_patient: bool
    to_patient: bool
    body: str
    created_at: datetime


@dataclass(frozen=True)
class PatientRow:
    id: UUID
    birth_date: date | None
    family: str | None
    given: list[str] | None
    prefix: list[str] | None
    suffix: list[str] | None
    text: str | None


@dataclass(frozen=True)
class StaffRow:
    id: UUID
    is_active: bool
    display_name: str
    codes: list[str]  # the role codes they hold at the facility asked about


@dataclass(frozen=True)
class RoleRow:
    id: UUID
    code: str
    name: str


@dataclass(frozen=True)
class NewItem:
    tenant_id: UUID
    kind: str
    priority: int
    title: str
    body: str | None
    facility_id: UUID
    assigned_user_id: UUID | None
    assigned_role_id: UUID | None
    due_at: datetime | None
    patient_id: UUID | None
    subject_type: str | None
    subject_id: UUID | None
    created_by: UUID


class InboxStore(Protocol):
    async def items(self, db: AsyncSession, scope: Scope, *, limit: int,
                    offset: int) -> list[ItemRow]: ...

    async def item(self, db: AsyncSession, scope: Scope, item_id: UUID, *,
                   lock: bool = False) -> ItemRow | None:
        """One item the scope may see (locked FOR UPDATE with ``lock``), else None."""
        ...

    async def summary(self, db: AsyncSession, scope: Scope) -> list[Any]: ...

    async def events(self, db: AsyncSession, item_id: UUID) -> list[EventRow]: ...

    async def replies(self, db: AsyncSession, item_id: UUID) -> list[ReplyRow]: ...

    async def patients(self, db: AsyncSession, ids: Iterable[UUID]) -> dict[UUID, PatientRow]: ...

    async def staff(self, db: AsyncSession, user_id: UUID, facility_id: UUID
                    ) -> StaffRow | None: ...

    async def role(self, db: AsyncSession, role_id: UUID) -> RoleRow | None: ...

    async def subject_patient(self, db: AsyncSession, kind: SubjectKind, record_id: UUID
                              ) -> tuple[bool, UUID | None]:
        """Whether the record exists in the clinic, and its patient."""
        ...

    async def merged_into(self, db: AsyncSession, patient_id: UUID) -> UUID | None: ...

    async def create(self, db: AsyncSession, item: NewItem) -> UUID: ...

    async def add_event(self, db: AsyncSession, tenant_id: UUID, item_id: UUID, event: str, *,
                        me: UUID, from_status: str | None = None, to_status: str | None = None,
                        assigned_user_id: UUID | None = None,
                        comment: str | None = None) -> None: ...

    async def update(self, db: AsyncSession, item_id: UUID, me: UUID, changes: dict[str, Any],
                     *, completed_now: bool = False) -> None: ...

    async def reply(self, db: AsyncSession, item_id: UUID, body: str, to_patient: bool
                    ) -> UUID: ...


class SqlInboxStore:
    async def items(self, db: AsyncSession, scope: Scope, *, limit: int,
                    offset: int) -> list[ItemRow]:
        sql = text(f"{_ITEM} WHERE {_VISIBLE} AND {_VIEWS[scope.view]} {_FILTERS} {_ORDER}")
        rows = await db.execute(sql, scope.params() | {"limit": limit, "offset": offset})
        return [ItemRow(**r._mapping) for r in rows]

    async def item(self, db: AsyncSession, scope: Scope, item_id: UUID, *,
                   lock: bool = False) -> ItemRow | None:
        sql = text(f"{_ITEM} WHERE w.id = :item AND {_VISIBLE}"
                   + (" FOR UPDATE OF w" if lock else ""))
        params = {k: v for k, v in scope.params().items()
                  if k in ("me", "roles", "facilities", "kinds", "adm")}
        row = (await db.execute(sql, params | {"item": item_id})).one_or_none()
        return ItemRow(**row._mapping) if row is not None else None

    async def summary(self, db: AsyncSession, scope: Scope) -> list[Any]:
        params = {k: v for k, v in scope.params().items()
                  if k in ("me", "roles", "facilities", "kinds", "adm")}
        return list(await db.execute(_SUMMARY, params))

    async def events(self, db: AsyncSession, item_id: UUID) -> list[EventRow]:
        return [EventRow(**r._mapping) for r in await db.execute(_EVENTS, {"item": item_id})]

    async def replies(self, db: AsyncSession, item_id: UUID) -> list[ReplyRow]:
        return [ReplyRow(**r._mapping) for r in await db.execute(_REPLIES, {"item": item_id})]

    async def patients(self, db: AsyncSession, ids: Iterable[UUID]) -> dict[UUID, PatientRow]:
        wanted = sorted(set(ids))
        if not wanted:
            return {}
        rows = await db.execute(_PATIENTS, {"ids": wanted})
        return {r.id: PatientRow(**r._mapping) for r in rows}

    async def staff(self, db: AsyncSession, user_id: UUID, facility_id: UUID
                    ) -> StaffRow | None:
        row = (await db.execute(_STAFF, {"user": user_id, "facility": facility_id})
               ).one_or_none()
        return StaffRow(**row._mapping) if row is not None else None

    async def role(self, db: AsyncSession, role_id: UUID) -> RoleRow | None:
        row = (await db.execute(_ROLE, {"role": role_id})).one_or_none()
        return RoleRow(**row._mapping) if row is not None else None

    async def subject_patient(self, db: AsyncSession, kind: SubjectKind, record_id: UUID
                              ) -> tuple[bool, UUID | None]:
        patient = kind.patient_column or "NULL::uuid"
        row = (await db.execute(text(
            f"SELECT {patient} AS patient_id FROM {kind.table} WHERE id = :id"),  # noqa: S608
            {"id": record_id})).one_or_none()
        return (row is not None, row.patient_id if row is not None else None)

    async def merged_into(self, db: AsyncSession, patient_id: UUID) -> UUID | None:
        return await fs.merged_into(db, patient_id)

    async def create(self, db: AsyncSession, item: NewItem) -> UUID:
        item_id = uuid4()
        subjects = {k.column: (item.subject_id if name == item.subject_type else None)
                    for name, k in SUBJECTS.items()}
        await db.execute(_CREATE, {
            "id": item_id, "tenant": item.tenant_id, "kind": item.kind,
            "priority": item.priority, "title": item.title, "body": item.body,
            "user": item.assigned_user_id, "role": item.assigned_role_id,
            "facility": item.facility_id, "due_at": item.due_at, "patient": item.patient_id,
            "me": item.created_by, **subjects})
        return item_id

    async def add_event(self, db: AsyncSession, tenant_id: UUID, item_id: UUID, event: str, *,
                        me: UUID, from_status: str | None = None, to_status: str | None = None,
                        assigned_user_id: UUID | None = None,
                        comment: str | None = None) -> None:
        await db.execute(_EVENT, {"tenant": tenant_id, "item": item_id, "event": event,
                                  "from_status": from_status, "to_status": to_status,
                                  "assigned": assigned_user_id, "comment": comment, "me": me})

    async def update(self, db: AsyncSession, item_id: UUID, me: UUID, changes: dict[str, Any],
                     *, completed_now: bool = False) -> None:
        unknown = set(changes) - UPDATABLE
        if unknown:
            raise ValueError(f"not updatable here: {sorted(unknown)}")
        sets = [f"{column} = :{column}" for column in sorted(changes)]
        sets += ["updated_at = now()", "updated_by_user_id = :me"]
        if completed_now:
            sets.append("completed_at = now()")
        await db.execute(text(
            f"UPDATE admin.work_item SET {', '.join(sets)} WHERE id = :item"),  # noqa: S608
            changes | {"item": item_id, "me": me})

    async def reply(self, db: AsyncSession, item_id: UUID, body: str, to_patient: bool
                    ) -> UUID:
        return await _write(db, _REPLY, {"item": item_id, "body": body,
                                         "to_patient": to_patient})


async def _write(db: AsyncSession, statement: TextClause, params: dict[str, object]) -> UUID:
    try:
        async with db.begin_nested():
            result: UUID = (await db.execute(statement, params)).scalar_one()
    except DBAPIError as error:
        detail = db_error_detail(error)
        # asyncpg keeps the constraint name on the driver's own exception.
        constraint = detail.constraint or getattr(
            getattr(error.orig, "__cause__", None), "constraint_name", None)
        if detail.sqlstate == "P0002":
            raise Refused("not-found") from None
        if detail.sqlstate == "P0001" and constraint:
            raise Refused(constraint) from None
        raise
    return result
