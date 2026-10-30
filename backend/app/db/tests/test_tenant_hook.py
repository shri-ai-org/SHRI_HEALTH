"""The tenant hook in app/db/session.py: fills tenant_id only where it is empty, never overwrites.

The first three tests need no database: they call the hook directly on a session that never
connects. The last one shows the backstop in a live database: a row given another clinic keeps
it, and forced row-level security refuses the insert.
"""

import subprocess
import sys
import uuid

import pytest
from sqlalchemy import Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.db import TENANT_ID_INFO_KEY
from app.db.models import MAPPERS
from app.db.session import _default_tenant
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant

CLINIC_A = uuid.UUID("0a000000-0000-4000-8000-00000000000a")
CLINIC_B = uuid.UUID("0b000000-0000-4000-8000-00000000000b")
Patient = MAPPERS["patient"]


def test_fills_an_empty_tenant_id() -> None:
    session = Session()
    session.info[TENANT_ID_INFO_KEY] = CLINIC_A
    row = Patient(gender="female")
    session.add(row)
    _default_tenant(session, None, None)
    assert row.tenant_id == CLINIC_A


def test_never_overwrites_a_tenant_id() -> None:
    session = Session()
    session.info[TENANT_ID_INFO_KEY] = CLINIC_A
    row = Patient(gender="female", tenant_id=CLINIC_B)
    session.add(row)
    _default_tenant(session, None, None)
    assert row.tenant_id == CLINIC_B


def test_does_nothing_without_the_key() -> None:
    session = Session()
    row = Patient(gender="female")
    session.add(row)
    _default_tenant(session, None, None)
    assert row.tenant_id is None


def test_reads_the_key_set_on_an_async_session() -> None:
    # The core sets the key on the AsyncSession; before_flush receives the sync Session.
    session = AsyncSession()
    session.info[TENANT_ID_INFO_KEY] = CLINIC_A
    row = Patient(gender="female")
    session.add(row)
    _default_tenant(session.sync_session, None, None)
    assert row.tenant_id == CLINIC_A


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_another_clinic_is_kept_and_refused_by_rls(db: Session, admin_engine: Engine) -> None:
    other = make_tenant(admin_engine)
    row = b.patient(db)  # filled by the hook from the session's clinic
    assert row.tenant_id == db.info[TENANT_ID_INFO_KEY]
    stranger = Patient(gender="male", birth_date=row.birth_date, tenant_id=other)
    savepoint = db.begin_nested()
    db.add(stranger)
    with pytest.raises(DBAPIError) as caught:
        db.flush()
    savepoint.rollback()
    assert stranger.tenant_id == other  # the hook did not move it to the session's clinic
    assert getattr(caught.value.orig, "sqlstate", None) == "42501"  # RLS WITH CHECK


def test_the_api_registers_the_hook_on_its_own() -> None:
    """In a fresh interpreter, importing the API must register the hook: this package's conftest
    imports it, so the in-process tests would pass without it."""
    code = ("import sys, app.main\n"
            "from sqlalchemy import event\n"
            "from sqlalchemy.orm import Session\n"
            "hook = sys.modules['app.db.session']._default_tenant\n"
            "assert event.contains(Session, 'before_flush', hook)\n")
    subprocess.run([sys.executable, "-c", code], check=True, timeout=120)  # noqa: S603  (fixed code)
