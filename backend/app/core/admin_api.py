"""Read-only administration screens (section 8 of the demo plan; x-owner thulasi): the roles and
what each may do (listRoles), the clinic's staff with their roles (listUsers), and the audit
trail (listAuditEvents). Nothing here writes, replays or changes a role.

- **Roles** come from core's catalogue, ROLE_PERMISSIONS, the only permission source
  (``admin.permission`` isn't seeded); ``admin.role`` holds only the codes, so the names are here.
- **Users** are the clinic's ``admin.app_user`` rows under forced row security, with their roles
  and facilities from ``admin.user_role``. No contact details, no Keycloak subjects.
- **The audit trail** is ``audit.audit_event``, read as ``shri_app`` (select is in its grants,
  D23) under the clinic's row security. It never carries a patient's name: the screen asks for
  names through ``POST /patients/summaries``, so restricted charts keep their rule (D37).
  ``breakGlass=true`` selects each grant's own row (action ``break-glass``, break_glass_api.py)
  and every chart access core recorded under a grant (purpose of use ``ETREAT``, access.py).
  ``breakGlassGrantId`` is set where the grant names its audit row
  (``audit.break_glass_access.audit_event_id``).
"""
from __future__ import annotations

import base64
import binascii
import datetime as dt
from typing import Annotated, Any, Literal
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, FastAPI, Query, Request
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import permissions
from app.core.audit import audit_detail
from app.core.config import Settings
from app.core.deps import CurrentUser, require, tenant_db
from app.core.errors import InvalidCursor, ValidationFailed, field_error
from app.core.routing import API_PREFIX

router = APIRouter(tags=["platform"])

#: The roles' names, as SECURITY_MODEL §4.1 gives them.
ROLE_NAMES: dict[str, tuple[str, str]] = {
    "FD": ("Front desk", "Registration, scheduling, check-in and check-out."),
    "MA": ("Medical assistant", "Rooming: vital signs, allergies, medications, reason for visit."),
    "RN": ("Nurse", "Nursing care and notes."),
    "MD": ("Physician", "Physicians (MD, DO): the chart, notes, prescriptions and orders."),
    "APP": ("Advanced practice provider", "Nurse practitioners and physician assistants; "
            "notes may need a co-signature."),
    "BIL": ("Billing", "Billing and revenue-cycle staff."),
    "ADM": ("Practice administrator", "Practice setup, users and the schedule; no clinical "
            "access by default."),
    "CO": ("Compliance officer", "Privacy and compliance: the audit trail and access reports."),
    "SUP": ("Platform support", "Shri platform support, with no access to patient data."),
    "DSP": ("Status board display", "A shared waiting-room screen: initials, times and status "
            "only."),
}

MAX_DAYS = 31


def _utc(at: dt.datetime) -> str:
    """The contract's Timestamp: UTC with `Z`, milliseconds at most (API_STANDARDS §6.1)."""
    return at.astimezone(dt.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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


def _page(rows: list[dict[str, Any]], offset: int, limit: int) -> dict[str, Any]:
    if len(rows) > limit:
        return {"items": rows[:limit], "nextCursor": _encode(offset + limit)}
    return {"items": rows}


def _like(prefix: str) -> str:
    """A LIKE pattern for a prefix, typed text taken literally (no wildcards)."""
    escaped = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%"


DB = Annotated[AsyncSession, Depends(tenant_db)]
Limit = Annotated[int, Query(ge=1, le=100)]
Cursor = Annotated[str | None, Query(max_length=512, pattern=r"^[A-Za-z0-9_-]+$")]

# ------------------------------------------------------------------------------------- roles
_USER_COUNTS = text("""
SELECT r.code, count(DISTINCT u.id) AS users
FROM admin.user_role ur
JOIN admin.role r ON r.id = ur.role_id
JOIN admin.app_user u ON u.id = ur.user_id AND u.is_active
WHERE ur.valid_to IS NULL OR ur.valid_to > now()
GROUP BY r.code
""")


@router.get("/roles", operation_id="listRoles")
async def list_roles(user: Annotated[CurrentUser, Depends(require("roles:read"))],
                     db: DB, limit: Limit = 25, cursor: Cursor = None) -> dict[str, Any]:
    offset = _decode(cursor)
    counts = {r.code: r.users for r in await db.execute(_USER_COUNTS)}
    items = []
    for code in sorted(permissions.ROLE_PERMISSIONS)[offset:offset + limit + 1]:
        name, description = ROLE_NAMES.get(code, (code, ""))
        items.append({"code": code, "name": name, "description": description,
                      "permissions": sorted(permissions.ROLE_PERMISSIONS[code]),
                      "userCount": counts.get(code, 0)})
    return _page(items, offset, limit)


# ------------------------------------------------------------------------------------- users
_USERS = text("""
SELECT u.id, u.display_name, u.username, u.is_active, u.practitioner_id, u.last_login_at,
       coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
       coalesce(array_agg(DISTINCT ur.facility_id) FILTER (WHERE ur.facility_id IS NOT NULL),
                '{}') AS facilities
FROM admin.app_user u
LEFT JOIN admin.user_role ur ON ur.user_id = u.id
     AND (ur.valid_to IS NULL OR ur.valid_to > now())
LEFT JOIN admin.role r ON r.id = ur.role_id
WHERE (CAST(:q AS text) IS NULL OR u.display_name ILIKE :q OR u.username ILIKE :q
       OR u.display_name ILIKE '% ' || :q)
GROUP BY u.id
HAVING CAST(:role AS text) IS NULL OR CAST(:role AS text) = ANY(array_agg(r.code))
ORDER BY lower(u.display_name), u.id
LIMIT :limit OFFSET :offset
""")


@router.get("/users", operation_id="listUsers")
async def list_users(user: Annotated[CurrentUser, Depends(require("users:read"))], db: DB,
                     q: Annotated[str | None, Query(min_length=1, max_length=100)] = None,
                     role: Annotated[str | None, Query(pattern=r"^[A-Z]{2,4}$")] = None,
                     limit: Limit = 25, cursor: Cursor = None) -> dict[str, Any]:
    if role is not None and role not in permissions.ROLE_PERMISSIONS:
        raise ValidationFailed(errors=[field_error("query", "role", "not-allowed-value")])
    offset = _decode(cursor)
    rows = await db.execute(_USERS, {"q": _like(q.strip()) if q and q.strip() else None,
                                     "role": role, "limit": limit + 1, "offset": offset})
    found = []
    for r in rows:
        item: dict[str, Any] = {
            "id": str(r.id), "displayName": r.display_name or r.username,
            "username": r.username, "roles": sorted(r.roles),
            "facilityIds": sorted(str(f) for f in r.facilities), "active": r.is_active}
        if r.practitioner_id is not None:
            item["practitionerId"] = str(r.practitioner_id)
        if r.last_login_at is not None:
            item["lastSignInAt"] = _utc(r.last_login_at)
        found.append(item)
    return _page(found, offset, limit)


# ------------------------------------------------------------------------------- audit trail
_ZONE = text("SELECT timezone FROM admin.tenant WHERE id = :id")
_AUDIT = text("""
SELECT e.id, e.recorded_at, e.actor_type, e.actor_user_id, e.actor_display, e.action,
       e.category, e.outcome, e.patient_id, e.entity_type, e.entity_id, e.reason,
       e.correlation_id, e.purpose_of_use, g.id AS grant_id
FROM audit.audit_event e
LEFT JOIN audit.break_glass_access g ON g.audit_event_id = e.id
WHERE e.recorded_at >= :start AND e.recorded_at < :end
  AND (CAST(:patient AS uuid) IS NULL OR e.patient_id = CAST(:patient AS uuid))
  AND (CAST(:actor AS uuid) IS NULL OR e.actor_user_id = CAST(:actor AS uuid))
  AND (CAST(:category AS text) IS NULL OR e.category::text = CAST(:category AS text))
  AND (CAST(:outcome AS text) IS NULL OR e.outcome::text = CAST(:outcome AS text))
  AND (NOT :break_glass OR e.action::text = 'break-glass' OR g.id IS NOT NULL
       OR e.purpose_of_use = 'ETREAT')
ORDER BY e.recorded_at DESC, e.id DESC
LIMIT :limit OFFSET :offset
""")

Category = Literal["phi-read", "phi-write", "sign", "export", "security", "ai", "admin", "none"]
Outcome = Literal["success", "failure", "denied"]


@router.get("/audit-events", operation_id="listAuditEvents")
async def list_audit_events(
        request: Request,
        user: Annotated[CurrentUser, Depends(require("audit-events:read"))], db: DB,
        date_from: Annotated[dt.date, Query(alias="dateFrom")],
        date_to: Annotated[dt.date, Query(alias="dateTo")],
        patient_id: Annotated[UUID | None, Query(alias="patientId")] = None,
        actor_user_id: Annotated[UUID | None, Query(alias="actorUserId")] = None,
        category: Category | None = None, outcome: Outcome | None = None,
        break_glass: Annotated[bool, Query(alias="breakGlass")] = False,
        limit: Limit = 25, cursor: Cursor = None) -> dict[str, Any]:
    if date_to < date_from:
        raise ValidationFailed(errors=[field_error("query", "dateTo", "out-of-range")])
    if (date_to - date_from).days >= MAX_DAYS:
        raise ValidationFailed(errors=[field_error("query", "dateTo", "out-of-range")])
    zone = ZoneInfo((await db.execute(_ZONE, {"id": user.organization_id})).scalar_one()
                    or "UTC")
    start = dt.datetime.combine(date_from, dt.time(), zone)
    end = dt.datetime.combine(date_to + dt.timedelta(days=1), dt.time(), zone)
    audit_detail(request, action="read")  # reading the audit trail is a security event
    offset = _decode(cursor)
    rows = await db.execute(_AUDIT, {
        "start": start, "end": end, "patient": patient_id, "actor": actor_user_id,
        "category": category, "outcome": outcome, "break_glass": break_glass,
        "limit": limit + 1, "offset": offset})
    return _page([_event(r) for r in rows], offset, limit)


def _event(r: Any) -> dict[str, Any]:
    actor: dict[str, Any] = {"type": str(r.actor_type),
                             "displayName": r.actor_display or str(r.actor_type).title()}
    if r.actor_user_id is not None:
        actor["userId"] = str(r.actor_user_id)
    item: dict[str, Any] = {
        "id": str(r.id), "recordedAt": _utc(r.recorded_at), "actor": actor,
        "action": str(r.action), "category": str(r.category), "outcome": str(r.outcome),
        "requestId": r.correlation_id or ""}
    for key, value in (("patientId", r.patient_id), ("entityType", r.entity_type),
                       ("entityId", r.entity_id), ("reason", r.reason),
                       ("breakGlassGrantId", r.grant_id)):
        if value is not None:
            item[key] = str(value)
    return item


def register(app: FastAPI, settings: Settings) -> None:
    app.include_router(router, prefix=API_PREFIX)
