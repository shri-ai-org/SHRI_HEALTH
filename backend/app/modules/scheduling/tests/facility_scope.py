"""The facility-scope sweep's shared pieces (SECURITY_MODEL §5.1, D37), used by each module's
``test_facility_scope_live.py``.

The rule: a user works at the facilities they are assigned to. A list sent without
``facilityId`` keeps to them; a record at another facility of the clinic is 404, as if it didn't
exist, for reads, writes and actions alike; another clinic's IDs are 404 too (RLS). Patient-level
data with no facility (the patient, allergies) follows §5.1's patient row: clinic-wide.

Each module's test is a table: one ``Row`` per call, run by ``sweep``, which checks the status,
that the other facility's IDs never appear in the body, and that nothing in either clinic changed
(``fingerprint``: every clinical and admin table with a ``tenant_id``, except the idempotency
records, which keep refused responses by design, T21). Synthetic data only.
"""

from __future__ import annotations

import datetime as dt
import importlib
import uuid
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi.routing import APIRoute
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_USERS, CurrentUser
from app.db.models import MAPPERS
from app.db.tests.conftest import sync_url

from .conftest import ZONE, Practice, setup_session

API = "/api/v1"
M = MAPPERS

#: Rows these tables gain on a refused request are expected: core stores a keyed request's
#: final 4xx answer for replay (T21), so it is not a change to the clinic's records.
NOT_RECORDS = frozenset({"admin.idempotency_record"})


# ------------------------------------------------------------------------------------- the data
def _tables() -> list[str]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.connect() as c:
            rows = c.execute(text(
                "SELECT c.table_schema || '.' || c.table_name FROM information_schema.columns c "
                "JOIN information_schema.tables t USING (table_schema, table_name) "
                "WHERE c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE' "
                "AND c.table_schema IN ('clinical', 'admin') ORDER BY 1")).scalars().all()
    finally:
        admin.dispose()
    return [r for r in rows if r not in NOT_RECORDS]


_TABLES: list[str] = []


def fingerprint(practice: Practice) -> dict[str, str]:
    """One digest per table over both clinics' rows: equal before and after means no write."""
    if not _TABLES:
        _TABLES.extend(_tables())
    sql = " UNION ALL ".join(
        f"SELECT '{t}' AS t, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) "
        f"FROM {t} x WHERE x.tenant_id IN (:a, :b)" for t in _TABLES)
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.connect() as c:
            found = c.execute(text(sql), {"a": practice.clinic, "b": practice.clinic_b}).all()
    finally:
        admin.dispose()
    return {r[0]: r[1] for r in found}


def staff(practice: Practice, users: dict[str, CurrentUser], key: str, like: str, *,
          facility: UUID | None = None, clinic_b: bool = False,
          practitioner: tuple[str, str] | None = None) -> CurrentUser:
    """Another signed-in user, ``key``, with dev user ``like``'s roles, at ``facility`` (A1 by
    default; clinic B's facility with ``clinic_b``). With ``practitioner`` (family, given) the
    user is linked to a practitioner of its own, so it can write notes."""
    tenant = practice.clinic_b if clinic_b else practice.clinic
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, tenant)
    try:
        practitioner_id = None
        if practitioner is not None:
            doctor = M["practitioner"]()
            doctor.name = [M["human_name"](family=practitioner[0], given=[practitioner[1]],
                                           prefix=["Dr."], use="official")]
            db.add(doctor)
            db.flush()
            practitioner_id = doctor.id
        made = M["app_user"](tenant_id=tenant, keycloak_subject=str(uuid.uuid4()),
                             username=f"{key}.{uuid.uuid4().hex[:8]}",
                             display_name=f"Dev {key}", practitioner_id=practitioner_id)
        db.add(made)
        db.flush()
        user_id: UUID = made.id
        db.commit()
    finally:
        db.close()
        admin.dispose()
    where = facility or (practice.facility_b if clinic_b else practice.facility)
    users[key] = CurrentUser(id=user_id, organization_id=tenant, roles=DEV_USERS[like].roles,
                             facility_ids=frozenset({where}), display_name=f"Dev {key}")
    return users[key]


def appointment_today(practice: Practice, patient: str, *, facility: UUID, provider: UUID,
                      hour: int, room: UUID | None = None) -> str:
    """A booked appointment today at ``hour``, facility time, with its provider (and room)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        start = dt.datetime.combine(dt.datetime.now(ZoneInfo(ZONE)).date(), dt.time(hour),
                                    ZoneInfo(ZONE))
        appt = M["appointment"](
            tenant_id=practice.clinic, status="booked", start=start,
            end=start + dt.timedelta(minutes=20), minutes_duration=20,
            subject_patient_id=practice.patients[patient],
            ext_appointment_type_id=practice.types["FU"], ext_facility_id=facility)
        appt.participant = [
            M["appointment_participant"](actor_patient_id=practice.patients[patient],
                                         status="accepted"),
            M["appointment_participant"](actor_practitioner_id=provider, status="accepted")]
        if room is not None:
            appt.participant.append(M["appointment_participant"](actor_location_id=room,
                                                                 status="accepted"))
        db.add(appt)
        db.flush()
        db.add(M["appointment_reason"](appointment_id=appt.id,
                                       reason_code_text="Follow-up on headaches."))
        appointment_id = str(appt.id)
        db.commit()
        return appointment_id
    finally:
        db.close()
        admin.dispose()


def served_operations(module: str) -> set[str]:
    """Every operationId the module's router serves (its api.py and the routers it includes),
    so a sweep's table can be checked for completeness."""
    def walk(routes: Iterable[Any]) -> set[str]:
        found: set[str] = set()
        for r in routes:
            if isinstance(r, APIRoute) and r.operation_id:
                found.add(r.operation_id)
            elif hasattr(r, "original_router"):  # a router api.py includes (FastAPI keeps it)
                found |= walk(r.original_router.routes)
        return found

    return walk(importlib.import_module(f"app.modules.{module}.api").router.routes)


# --------------------------------------------------------------------------------- the table
@dataclass(frozen=True)
class Row:
    """One call. ``expect`` is the status; ``hidden`` are IDs that must not appear in the body
    (the other facility's records), ``shown`` IDs that must (the user's own, so an empty answer
    can't pass by accident). ``writes`` marks a call expected to change data (a patient-level
    write that is clinic-wide by design), the only rows whose fingerprint may move."""
    operation: str
    user: str
    method: str
    path: str
    expect: int
    json: Any = None
    params: dict[str, Any] | None = None
    headers: dict[str, str] | None = None
    hidden: tuple[str, ...] = ()
    shown: tuple[str, ...] = ()
    writes: bool = False
    note: str = ""


@dataclass
class Outcome:
    row: Row
    status: int
    problems: list[str] = field(default_factory=list)


def sweep(client: Any, practice: Practice, rows: Iterable[Row]) -> list[Outcome]:
    """Run every row; each outcome lists what didn't match (empty when it did)."""
    out = []
    for row in rows:
        before = fingerprint(practice)
        response = client(row.user).request(row.method, row.path, json=row.json,
                                            params=row.params, headers=row.headers)
        result = Outcome(row, response.status_code)
        if response.status_code != row.expect:
            result.problems.append(f"status {response.status_code}, expected {row.expect}: "
                                   f"{response.text[:300]}")
        body = response.text
        result.problems += [f"shows the other facility's {h}" for h in row.hidden if h in body]
        result.problems += [f"leaves out its own {s}" for s in row.shown if s not in body]
        if not row.writes:
            after = fingerprint(practice)
            changed = sorted(t for t in after if after[t] != before.get(t))
            if changed:
                result.problems.append(f"changed {', '.join(changed)}")
        out.append(result)
    return out


def report(outcomes: list[Outcome]) -> str:
    lines = [f"{'operation':34} {'user':8} {'expected':>8} {'actual':>6}  problems"]
    for o in outcomes:
        note = f"  ({o.row.note})" if o.row.note else ""
        lines.append(f"{o.row.operation:34} {o.row.user:8} {o.row.expect:>8} {o.status:>6}  "
                     f"{'; '.join(o.problems) or 'ok'}{note}")
    return "\n".join(lines)


def failures(outcomes: list[Outcome]) -> list[Outcome]:
    return [o for o in outcomes if o.problems]
