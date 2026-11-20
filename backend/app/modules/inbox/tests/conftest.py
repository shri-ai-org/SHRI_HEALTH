"""Live fixtures for the inbox: scheduling's practice (clinic A with facilities A1 and A2, a
restricted chart, and clinic B), staff users with real ``user_role`` rows (so assignee checks
read the database as they will in production), and the real app as shri_app with the X-Dev-User
stand-in. Patient messages are started the only way they can be, through
``admin.portal_create_message`` as shri_portal. Synthetic data only."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine, func, text
from sqlalchemy.pool import NullPool

from app.core.deps import CurrentUser
from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (a fixture)
    Practice,
    make_client,
    practice,
    setup_session,
)

M = MAPPERS

#: name -> (role codes, at facility A2 instead of A1, in clinic B)
STAFF: dict[str, tuple[tuple[str, ...], bool, bool]] = {
    "fd": (("FD",), False, False), "fd2": (("FD",), False, False),
    "ma": (("MA",), False, False), "rn": (("RN",), False, False),
    "md": (("MD",), False, False), "adm": (("ADM",), False, False),
    "bil": (("BIL",), False, False), "dsp": (("DSP",), False, False),
    "none": ((), False, False), "md-north": (("MD",), True, False),
    "md-b": (("MD",), False, True),
}


@dataclass
class Clinic:
    practice: Practice
    users: dict[str, CurrentUser]
    roles: dict[str, UUID]  # platform role ID by code

    @property
    def clinic(self) -> UUID:
        return self.practice.clinic

    def id(self, name: str) -> UUID:
        return self.users[name].id


@pytest.fixture
def inbox(practice: Practice) -> Clinic:  # noqa: F811 (scheduling's fixture)
    admin = create_engine(sync_url(), poolclass=NullPool)
    users: dict[str, CurrentUser] = {}
    try:
        with admin.connect() as c:
            roles = {r.code: r.id for r in c.execute(text(
                "SELECT code, id FROM admin.role WHERE tenant_id IS NULL"))}
        for name, (codes, north, clinic_b) in STAFF.items():
            tenant = practice.clinic_b if clinic_b else practice.clinic
            facility = (practice.facility_b if clinic_b
                        else practice.other_facility if north else practice.facility)
            db = setup_session(admin, tenant)
            try:
                display = f"{name.upper()} Tester{len(users) + 101}"
                user = M["app_user"](tenant_id=tenant, keycloak_subject=str(uuid.uuid4()),
                                     username=f"{name}.{uuid.uuid4().hex[:8]}",
                                     display_name=display)
                db.add(user)
                db.flush()
                for code in codes:
                    db.add(M["user_role"](tenant_id=tenant, user_id=user.id,
                                          role_id=roles[code], facility_id=facility))
                user_id = user.id
                db.commit()
            finally:
                db.close()
            users[name] = CurrentUser(id=user_id, organization_id=tenant,
                                      roles=frozenset(codes), facility_ids=frozenset({facility}),
                                      display_name=display)
    finally:
        admin.dispose()
    return Clinic(practice, users, roles)


@pytest.fixture
def client(inbox: Clinic) -> Iterator[Any]:
    """The live app as shri_app; ``client("md")`` signs in as that user."""
    yield from make_client(inbox.users, pending=False)


def owner(sql: str, **params: Any) -> list[Any]:
    """As the superuser, outside any clinic (checks and set-up)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            result = c.execute(text(sql), params)
            return list(result) if result.returns_rows else []
    finally:
        admin.dispose()


def as_portal(clinic: UUID, patient: UUID, sql: str, **params: Any) -> list[Any]:
    """As shri_portal in the patient's session, as the portal's requests run (D93)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            c.execute(text("SET LOCAL ROLE shri_portal"))
            c.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                           "set_config('app.current_patient_id', :p, true)"),
                      {"t": str(clinic), "p": str(patient)})
            return list(c.execute(text(sql), params))
    finally:
        admin.dispose()


def portal_message(clinic: UUID, patient: UUID, subject: str, body: str) -> UUID:
    found: UUID = as_portal(clinic, patient, "SELECT admin.portal_create_message(:s, :b)",
                            s=subject, b=body)[0][0]
    return found


def work_item(clinic: Clinic, **values: Any) -> UUID:
    """An item the inbox service would create from an event (a co-sign, say), written directly
    with its ``created`` event."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, clinic.clinic)
    try:
        values = {"status": "open", "priority": 4, "escalation_level": 0,
                  "facility_id": clinic.practice.facility, **values}
        item = M["work_item"](tenant_id=clinic.clinic, **values)
        db.add(item)
        db.flush()
        db.add(M["work_item_event"](tenant_id=clinic.clinic, work_item_id=item.id,
                                    event="created", to_status="open",
                                    assigned_user_id=values.get("assigned_user_id"),
                                    occurred_at=func.now(),
                                    user_id=values.get("created_by_user_id")))
        item_id: UUID = item.id
        db.commit()
        return item_id
    finally:
        db.close()
        admin.dispose()


__all__ = ["TEST_DATABASE_URL", "Clinic", "as_portal", "owner", "portal_message", "work_item"]
