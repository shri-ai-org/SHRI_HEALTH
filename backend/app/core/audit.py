"""Audit rows written from the contract's x-audit (SECURITY_MODEL §6, EXTENSIONS.md).

Endpoints write no audit code. tenant_db starts an audit trail for the route's operation, and
core writes it:

- **Writes go in the endpoint's own transaction.** The rows are inserted when the endpoint
  calls `await db.commit()`, so the change and its audit row commit together or not at all.
- **Everything else is written before the response starts.** If the endpoint did not commit,
  core rolls back whatever it left uncommitted, writes the audit rows and commits them, then
  sends the response.
- **Audit fails closed (T17).** If the rows cannot be written, the request fails: the commit
  raises, or the response becomes a 500.
- Only successful requests (status below 400) are audited this way. A permission refusal is
  audited by require() as a security event (`record_denial`).
- **One commit with changes per audited request.** After the commit that wrote the request's
  audit rows, a further commit that carries changes is refused with a 500 and its changes are
  never saved, so no change can go in without its audit row. A commit with nothing to save is
  allowed.
- **Public forms.** The pre-registration form's database function writes its own `anonymous`
  audit row in the same call as the request (D96, migration 0009), so deps.public_db starts no
  trail (operations.AUDITED_IN_DATABASE). start_public_trail() remains for a later form whose
  clinic core resolves: actor type `anonymous`, no user, no patient.
- **The portal.** For x-audit `patient: session` the patient comes only from the portal
  session (deps.portal_session), never from the path, body or query, and a request without a
  portal session fails (500). `actor: patient` records the patient as the actor: actor type
  `patient`, with that patient's ID in `patient_id` (audit_event has no actor column for
  patients; actor_user_id is for staff).

What the endpoint adds, only where the contract says so:

    audit_patients(request, ids)   x-audit patient "result" or "body:/…": the patients the
                                   request touched or returned, before the commit or response
                                   (an empty list for a search that found nobody)
    audit_detail(request, action=…, reason=…)
                                   the audit action, where the category alone does not say it:
                                   required for category "security" (break-glass, restrict, …)

Rows never hold request or response bodies, only who, what, which record, which patient,
outcome, time and request ID (SECURITY_MODEL §6).
"""

import ipaddress
import logging
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from fastapi import FastAPI
from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import ORMExecuteState, Session
from sqlalchemy.sql.elements import TextClause
from starlette.requests import Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.config import Settings
from app.core.errors import InternalError, problem
from app.core.operations import Operation, operation_for
from app.core.request_id import current_request_id

if TYPE_CHECKING:
    from app.core.deps import CurrentUser, PortalPatient

log = logging.getLogger(__name__)

TRAIL_STATE = "shri_audit_trail"  # request.state and session.info key

# audit.audit_event.action (ck_audit_event_action_codes)
ACTIONS = frozenset({
    "read", "create", "update", "delete", "sign", "export", "print", "login", "logout",
    "access-denied", "ai-request", "ai-review", "merge", "break-glass", "config-change",
})
_BY_LETTER = {"R": "read", "C": "create", "U": "update", "E": "update"}

_COLUMNS = (
    "tenant_id", "actor_type", "actor_user_id", "actor_display", "action", "outcome",
    "entity_type", "entity_id", "patient_id", "purpose_of_use", "reason", "source_ip",
    "user_agent", "correlation_id",
)
_CATEGORY_CACHE = "shri_audit_has_category"

# session.info: set after the commit that wrote the request's audit rows; and whether SQL that
# changes data ran since the last commit (raw text() DML never shows in session.dirty).
AUDIT_COMMITTED = "audit_committed"
_CHANGED_SINCE_COMMIT = "shri_changed_since_commit"
_TEXT_DML = re.compile(r"^\s*(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b", re.IGNORECASE)
_TEXT_CTE_DML = re.compile(
    r"\b(INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|UPDATE\s+[\w.\"]+\s+(AS\s+\w+\s+)?SET)\b",
    re.IGNORECASE)


def event_action(operation: Operation, override: str | None = None) -> str:
    """The audit_event action for an operation's x-audit, unless the endpoint named one."""
    if override is not None:
        return override
    rule = operation.audit
    if rule.category == "security":
        raise RuntimeError(f"{operation.operation_id} is a security operation: name its audit "
                           "action with audit_detail(request, action=...)")
    if rule.category in ("sign", "export"):
        return rule.category
    if rule.action == "R":
        return "read"
    if rule.category == "admin":
        return "config-change"
    if rule.category == "ai":
        return "ai-request"
    return _BY_LETTER[rule.action]


def entity(operation: Operation, path_params: dict[str, Any]) -> tuple[str | None, str | None]:
    """Which record: the resource segment before the path's last parameter, and its value
    (/patients/{patientId}/coverages/{coverageId}/entered-in-error → coverages, coverageId).
    A path without parameters names its first segment (/patients/search → patients)."""
    segments = operation.path.split("/")[3:]  # after "", "api", "v1"
    for i in range(len(segments) - 1, 0, -1):
        if segments[i].startswith("{"):
            value = path_params.get(segments[i][1:-1])
            return segments[i - 1], str(value) if value is not None else None
    return (segments[0] or None) if segments else None, None


def _client_ip(request: Request) -> str | None:
    host = request.client.host if request.client else None
    try:
        return str(ipaddress.ip_address(host)) if host else None
    except ValueError:  # e.g. the test client's "testclient"
        return None


@dataclass
class AuditTrail:
    """What one request will write to the audit log."""

    operation: Operation
    user: "CurrentUser | None"  # the staff user; None on the portal
    session: AsyncSession
    path_params: dict[str, Any]
    request_id: str | None
    source_ip: str | None
    user_agent: str | None
    portal: "PortalPatient | None" = None  # the signed-in patient (deps.portal_session)
    clinic_id: UUID | None = None  # a public form's clinic (start_public_trail)
    patient_ids: list[UUID] | None = None
    action: str | None = None
    reason: str | None = None
    purpose_of_use: str | None = None  # ETREAT: opened through a break-glass grant
    written: bool = False
    _committing: bool = False

    def _patients(self) -> list[UUID | None]:
        source = self.operation.audit.patient
        if source is None:
            return [self.portal.patient_id if self.portal else None]
        if source == "session":
            return [self._portal_patient().patient_id]
        if source.startswith("body:") or source == "result":
            if self.patient_ids is None:
                raise RuntimeError(f"{self.operation.operation_id}: x-audit patient is "
                                   f"{source!r}, so call audit_patients(request, ids) before "
                                   "the commit or the response")
            return list(self.patient_ids) or [None]
        return [UUID(str(self.path_params[source]))]

    def _portal_patient(self) -> "PortalPatient":
        if self.portal is None:
            raise RuntimeError(f"{self.operation.operation_id}: the patient comes from the portal "
                               "session, and this request has none (use Depends(portal_session))")
        return self.portal

    def _actor(self) -> dict[str, Any]:
        if self.operation.audit.actor == "anonymous":
            if self.clinic_id is None:
                raise RuntimeError(f"{self.operation.operation_id}: a public form's clinic comes "
                                   "from the portal host, and this request has none "
                                   "(use Depends(public_db))")
            return {"tenant_id": self.clinic_id, "actor_type": "anonymous",
                    "actor_user_id": None, "actor_display": None}
        if self.operation.audit.actor == "patient":
            patient = self._portal_patient()
            return {"tenant_id": patient.organization_id, "actor_type": "patient",
                    "actor_user_id": None, "actor_display": None}
        if self.user is None:
            raise RuntimeError(f"{self.operation.operation_id}: no signed-in staff user to audit")
        return {"tenant_id": self.user.organization_id, "actor_type": self.operation.audit.actor,
                "actor_user_id": self.user.id,
                "actor_display": self.user.display_name[:200] or None}

    def rows(self) -> list[dict[str, Any]]:
        entity_type, entity_id = entity(self.operation, self.path_params)
        action = event_action(self.operation, self.action)
        common = {
            **self._actor(),
            "action": action,
            "outcome": "success",
            "category": self.operation.audit.category,
            "entity_type": entity_type,
            "entity_id": entity_id,
            "reason": self.reason,
            "purpose_of_use": self.purpose_of_use,
            "source_ip": self.source_ip,
            "user_agent": self.user_agent,
            "correlation_id": self.request_id,
        }
        return [{**common, "patient_id": patient_id} for patient_id in self._patients()]

    async def write_now(self) -> None:
        """For a request that did not commit: drop what it left uncommitted (tenant_db's
        promise) and commit only the audit rows, which the before_commit hook inserts."""
        await self.session.rollback()
        await self.session.commit()


def start_trail(request: Request, user: "CurrentUser", session: AsyncSession) -> None:
    """Called by tenant_db. Routes outside the contract (only test apps have them; create_app
    refuses to start with one) and operations with x-audit category "none" write nothing."""
    _start(request, session, user=user, portal=None)


def start_portal_trail(request: Request, patient: "PortalPatient", session: AsyncSession) -> None:
    """Called by deps.portal_db, with the patient from the portal session."""
    _start(request, session, user=None, portal=patient)


def start_public_trail(request: Request, clinic_id: UUID, session: AsyncSession) -> None:
    """For a later public form whose clinic core resolves. deps.public_db doesn't call it: the
    pre-registration form's database function writes its own audit row (D96)."""
    _start(request, session, user=None, portal=None, clinic_id=clinic_id)


def _start(request: Request, session: AsyncSession, *, user: "CurrentUser | None",
           portal: "PortalPatient | None", clinic_id: UUID | None = None) -> None:
    operation = operation_for(request.scope.get("route"))
    if operation is None or not operation.audit.audited:
        return
    trail = AuditTrail(
        operation=operation, user=user, session=session,
        path_params=dict(request.path_params), request_id=current_request_id(),
        source_ip=_client_ip(request),
        user_agent=(request.headers.get("user-agent") or "")[:300] or None, portal=portal,
        clinic_id=clinic_id,
    )
    session.info[TRAIL_STATE] = trail
    setattr(request.state, TRAIL_STATE, trail)


def _trail(request: Request) -> AuditTrail | None:
    trail: AuditTrail | None = getattr(request.state, TRAIL_STATE, None)
    if trail is None:
        operation = operation_for(request.scope.get("route"))
        if operation is not None and operation.audit.audited:
            raise RuntimeError(f"{operation.operation_id} is audited: use Depends(tenant_db)")
    return trail


def audit_patients(request: Request, patient_ids: Iterable[UUID]) -> None:
    """The patients this request touched or returned, for x-audit patient "result" or
    "body:/…". Call it before `db.commit()` (writes) or before returning (reads)."""
    trail = _trail(request)
    if trail is None:
        return
    source = trail.operation.audit.patient or ""
    if not (source.startswith("body:") or source == "result"):
        raise RuntimeError(f"{trail.operation.operation_id}: the patient comes from "
                           f"{source or 'nowhere'!r}, not from the endpoint")
    trail.patient_ids = list(dict.fromkeys(patient_ids))


def audit_detail(request: Request, *, action: str, reason: str | None = None) -> None:
    """The audit action (and a reason, e.g. break-glass) where x-audit alone does not say it."""
    if action not in ACTIONS:
        raise ValueError(f"Unknown audit action {action!r}")
    if reason is not None and len(reason) > 500:
        raise ValueError("An audit reason is at most 500 characters")
    trail = _trail(request)
    if trail is None:
        return
    trail.action, trail.reason = action, reason


def _has_category(connection: Connection) -> bool:
    """Migration 0005 (#52) adds audit_event.category. Until it is applied the rows go in
    without it, and 0005 derives the category from the action. Cached per database connection;
    the API restarts after migrations. Remove this check once 0005 is on main."""
    cached = connection.info.get(_CATEGORY_CACHE)
    if cached is None:
        cached = bool(connection.execute(text(
            "SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = "
            "'audit.audit_event'::regclass AND attname = 'category' AND NOT attisdropped)"
        )).scalar_one())
        connection.info[_CATEGORY_CACHE] = cached
    return cached


def insert_rows(connection: Connection, rows: list[dict[str, Any]]) -> None:
    """INSERT with no RETURNING: shri_app may read back only id and recorded_at (0005)."""
    columns = _COLUMNS + (("category",) if _has_category(connection) else ())
    statement = text(
        f"INSERT INTO audit.audit_event ({', '.join(columns)}) "  # noqa: S608 (fixed names)
        f"VALUES ({', '.join(':' + c for c in columns)})"
    )
    connection.execute(statement, [{c: row[c] for c in columns} for row in rows])


def _is_text_dml(statement: object) -> bool:
    if not isinstance(statement, TextClause):
        return False
    sql = statement.text
    return bool(_TEXT_DML.match(sql) or (sql.lstrip()[:4].upper() == "WITH"
                                        and _TEXT_CTE_DML.search(sql)))


@event.listens_for(Session, "do_orm_execute")
def _note_changes(state: ORMExecuteState) -> None:
    """Marks SQL that changes data, which session.dirty can't see: Core insert(), update() and
    delete(), and text() statements. (SQL run on session.connection() directly is not seen.)"""
    if state.is_insert or state.is_update or state.is_delete or _is_text_dml(state.statement):
        state.session.info[_CHANGED_SINCE_COMMIT] = True


@event.listens_for(Session, "after_flush")
def _note_flushed_changes(session: Session, _flush_context: Any) -> None:
    """A flush that wrote ORM objects (an autoflush before a query, say) empties session.new
    and session.dirty before the commit, so it is noted here."""
    if session.new or session.deleted or session.dirty:
        session.info[_CHANGED_SINCE_COMMIT] = True


def _has_changes(session: Session) -> bool:
    return bool(session.info.get(_CHANGED_SINCE_COMMIT) or session.new or session.deleted
                or any(session.is_modified(o) for o in session.dirty))


@event.listens_for(Session, "before_commit")
def _write_with_the_commit(session: Session) -> None:
    trail: AuditTrail | None = session.info.get(TRAIL_STATE)
    if session.info.get(AUDIT_COMMITTED):
        if _has_changes(session):
            # The transaction stays open and tenant_db's session rolls it back when the request
            # ends, so these changes are never saved.
            log.error("A second commit with changes in one audited request (%s, request %s)",
                      trail.operation.operation_id if trail else "?", current_request_id())
            raise InternalError("A request may save its changes only once")
        return
    if trail is None or trail.written:
        return
    rows = trail.rows()  # raises if the endpoint has not named its patients
    session.flush()  # the rows may name a patient this transaction creates
    insert_rows(session.connection(), rows)
    trail._committing = True


@event.listens_for(Session, "after_commit")
def _committed(session: Session) -> None:
    trail: AuditTrail | None = session.info.get(TRAIL_STATE)
    session.info[_CHANGED_SINCE_COMMIT] = False
    if trail is not None and trail._committing:
        trail.written, trail._committing = True, False
        session.info[AUDIT_COMMITTED] = True


@event.listens_for(Session, "after_rollback")
def _rolled_back(session: Session) -> None:
    session.info[_CHANGED_SINCE_COMMIT] = False
    trail: AuditTrail | None = session.info.get(TRAIL_STATE)
    if trail is not None:
        trail._committing = False


async def record_denial(request: Request, user: "CurrentUser", permission: str) -> None:
    """A refused permission is a security event (SECURITY_MODEL §3 step 8). No patient ID: the
    request was refused before anything was read, and an unchecked ID could be anyone's."""
    db = request.app.state.db
    if db is None:  # no database configured (unit tests, local runs without PostgreSQL)
        return
    operation = operation_for(request.scope.get("route"))
    entity_type, entity_id = (entity(operation, dict(request.path_params))
                              if operation else (None, None))
    row = {
        "tenant_id": user.organization_id, "actor_type": "user", "actor_user_id": user.id,
        "actor_display": user.display_name[:200] or None, "action": "access-denied",
        "outcome": "denied", "category": "security", "entity_type": entity_type,
        "entity_id": entity_id, "patient_id": None, "purpose_of_use": None,
        "reason": f"permission-denied: requires {permission}", "source_ip": _client_ip(request),
        "user_agent": (request.headers.get("user-agent") or "")[:300] or None,
        "correlation_id": current_request_id(),
    }
    try:
        async with db.tenant_session(user.organization_id, user.id,
                                     current_request_id()) as session:
            await session.run_sync(lambda s: insert_rows(s.connection(), [row]))
            await session.commit()
    except Exception:
        # The request is refused either way; a lost denial row must still be seen.
        log.exception("Could not audit a permission denial (request %s)", current_request_id())


class AuditMiddleware:
    """Writes a successful request's audit rows before its response starts, if the endpoint's
    own commit has not; if they cannot be written, the client gets a 500 instead."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        replaced = False

        async def send_after_audit(message: Message) -> None:
            nonlocal replaced
            if replaced:
                return  # the app's own response was dropped for the 500
            if message["type"] == "http.response.start" and message["status"] < 400:
                trail: AuditTrail | None = scope.get("state", {}).get(TRAIL_STATE)
                if trail is not None and not trail.written:
                    try:
                        await trail.write_now()
                    except Exception:
                        log.exception("Audit write failed; the request fails (request %s)",
                                      trail.request_id)
                        replaced = True
                        response = problem(Request(scope), "internal-error",
                                           "The request could not be audited")
                        await response(scope, receive, send)
                        return
            await send(message)

        await self.app(scope, receive, send_after_audit)


def register(app: FastAPI, settings: Settings) -> None:
    """AuditMiddleware (innermost: it sees the final status)."""
    app.add_middleware(AuditMiddleware)
