"""Facility scope and restricted charts (SECURITY_MODEL §5, API_STANDARDS §12, D37).

Facility scope. A user works at the facilities they are assigned to:

    facility_filter(user, Appointment.facility_id)     add to every list query's WHERE
    require_facility(user, body.facility_id)           404 for a facility not theirs
    facility_scope(user, facility_id)                  a list's `facilityId` filter, or all theirs

tenant_db already refuses a `facilityId` query parameter the user is not assigned to (404), so
a list endpoint only adds `facility_filter` for calls without one.

Restricted charts. Every patient-scoped endpoint calls, before it reads or writes the chart:

    await ensure_chart_access(db, user, patient_id)

It answers 404 for a patient the clinic does not have (or another clinic's), and 403
`break-glass-required` for a restricted chart unless the user is on the patient's care team
(D37) or holds a current break-glass grant. A refusal is audited (category security, with the
patient) and that row is kept although the request fails. Access through a grant is marked
on the request's own audit rows (purpose of use ETREAT).

Call it first, before the endpoint reads or locks anything. The refusal row is written on a
second connection; if the endpoint already holds a lock on the patient row (`SELECT … FOR
UPDATE` for an If-Match check, say) or has written an audit row in its open transaction, that
connection waits for this one. It gives up after REFUSAL_LOCK_TIMEOUT, so the request fails
with a 500 (fail closed) instead of hanging.

The front-desk exceptions (SECURITY_MODEL §5.2 rule 2: search, and booking and check-in, with
name and appointment only) do not call ensure_chart_access; they call `chart_access()` to
know whether they may show more than that (e.g. the status board's reason for visit, D60).
"""

import enum
import logging
from collections.abc import Iterable
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, false, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import audit
from app.core.db import DATABASE_INFO_KEY
from app.core.deps import CurrentUser
from app.core.errors import Forbidden, NotFound
from app.core.request_id import current_request_id

log = logging.getLogger(__name__)

RESTRICTED_LABELS = ("R", "V")  # patient.meta_security: restricted, very restricted

# How long the refusal row may wait for a lock the request itself holds (see the docstring).
REFUSAL_LOCK_TIMEOUT = "2s"

_CHART = text("""
SELECT p.meta_security && CAST(:labels AS varchar[]) AS restricted,
       EXISTS (
         SELECT 1 FROM admin.care_team_member m
         LEFT JOIN admin.app_user u ON u.practitioner_id = m.practitioner_id
         WHERE m.patient_id = p.id
           AND (m.user_id = :user_id OR u.id = :user_id)
           AND m.period_start <= current_date
           AND (m.period_end IS NULL OR m.period_end >= current_date)
       ) AS care_team,
       EXISTS (
         SELECT 1 FROM audit.break_glass_access g
         WHERE g.patient_id = p.id AND g.user_id = :user_id
           AND g.granted_at <= now() AND g.expires_at > now()
       ) AS granted
FROM clinical.patient p
WHERE p.id = :patient_id
""")


class ChartAccess(enum.Enum):
    NOT_FOUND = "not-found"
    OPEN = "open"  # not restricted
    CARE_TEAM = "care-team"  # restricted, and the user is on the care team (D37)
    BREAK_GLASS = "break-glass"  # restricted, with a current grant
    BLOCKED = "blocked"  # restricted, neither

    @property
    def allowed(self) -> bool:
        return self in (ChartAccess.OPEN, ChartAccess.CARE_TEAM, ChartAccess.BREAK_GLASS)


def facility_filter(user: CurrentUser, column: Any) -> ColumnElement[bool]:
    """WHERE clause limiting a query to the user's facilities (none assigned: no rows)."""
    if not user.facility_ids:
        return false()
    result: ColumnElement[bool] = column.in_(sorted(user.facility_ids))
    return result


def require_facility(user: CurrentUser, facility_id: UUID | None) -> UUID:
    """A facility the request names (body or path) must be one of the user's: 404 otherwise,
    exactly as for a facility that does not exist (API_STANDARDS §12)."""
    if facility_id is None or facility_id not in user.facility_ids:
        raise NotFound()
    return facility_id


def facility_scope(user: CurrentUser, facility_id: UUID | None = None) -> frozenset[UUID]:
    """The facilities a list covers: the one asked for (checked), or all of the user's."""
    if facility_id is not None:
        return frozenset({require_facility(user, facility_id)})
    return user.facility_ids


def check_facility_query(user: CurrentUser, values: Iterable[str]) -> None:
    """tenant_db's check of the `facilityId` query parameter. A malformed value is left to
    request validation (422), which reports it after the dependencies run."""
    for value in values:
        try:
            facility_id = UUID(value)
        except ValueError:
            continue
        require_facility(user, facility_id)


async def chart_access(db: AsyncSession, user: CurrentUser, patient_id: UUID) -> ChartAccess:
    """How the user may open this chart. Reads only; writes no audit row."""
    row = (await db.execute(_CHART, {
        "patient_id": patient_id, "user_id": user.id, "labels": list(RESTRICTED_LABELS),
    })).one_or_none()
    if row is None:
        return ChartAccess.NOT_FOUND
    if not row.restricted:
        return ChartAccess.OPEN
    if row.care_team:
        return ChartAccess.CARE_TEAM
    if row.granted:
        return ChartAccess.BREAK_GLASS
    return ChartAccess.BLOCKED


async def ensure_chart_access(db: AsyncSession, user: CurrentUser, patient_id: UUID) -> ChartAccess:
    """404 for an unknown patient, 403 break-glass-required for a restricted chart the user may
    not open (audited), otherwise how access was granted."""
    access = await chart_access(db, user, patient_id)
    if access is ChartAccess.NOT_FOUND:
        raise NotFound()
    if access is ChartAccess.BREAK_GLASS:
        trail = db.info.get(audit.TRAIL_STATE)
        if trail is not None:
            trail.purpose_of_use = "ETREAT"
    if access is ChartAccess.BLOCKED:
        await _record_blocked(db, user, patient_id)
        raise Forbidden("This chart is restricted: state a reason for emergency access",
                        code="break-glass-required")
    return access


async def _record_blocked(db: AsyncSession, user: CurrentUser, patient_id: UUID) -> None:
    """In its own transaction, so the row survives the 403 and nothing the endpoint started
    is committed with it. Fails closed: if the row cannot be written, the request fails."""
    database = db.info.get(DATABASE_INFO_KEY)
    if database is None:
        raise RuntimeError("ensure_chart_access needs the session from tenant_db")
    trail = db.info.get(audit.TRAIL_STATE)
    entity_type, entity_id = (audit.entity(trail.operation, trail.path_params)
                              if trail is not None else ("patients", str(patient_id)))
    row = {
        "tenant_id": user.organization_id, "actor_type": "user", "actor_user_id": user.id,
        "actor_display": user.display_name[:200] or None, "action": "access-denied",
        "outcome": "denied", "category": "security", "entity_type": entity_type,
        "entity_id": entity_id, "patient_id": patient_id, "purpose_of_use": None,
        "reason": "break-glass-required: restricted chart",
        "source_ip": trail.source_ip if trail else None,
        "user_agent": trail.user_agent if trail else None,
        "correlation_id": current_request_id(),
    }

    def write(sync_session: Any) -> None:
        connection = sync_session.connection()
        connection.execute(text(f"SET LOCAL lock_timeout = '{REFUSAL_LOCK_TIMEOUT}'"))
        audit.insert_rows(connection, [row])

    async with database.tenant_session(user.organization_id, user.id,
                                       current_request_id()) as session:
        await session.run_sync(write)
        await session.commit()
