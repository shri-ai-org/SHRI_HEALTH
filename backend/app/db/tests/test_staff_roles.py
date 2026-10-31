"""Migration 0017: the staff roles sign-in reads are exactly core's ROLE_PERMISSIONS, every clinic
reads them and no clinic can change them. Synthetic data only."""
from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.exc import DBAPIError

from app.core.permissions import ROLE_PERMISSIONS
from app.core.session import _ROLES as CORE_ROLE_QUERY
from app.db.tests import builders as b
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, open_session
from app.db.tools import gen_db_rules

FROZEN_0017 = (Path(__file__).resolve().parents[1]
               / "alembic/versions/sql_0017/01_staff_roles.sql")


def test_the_role_rows_are_generated_from_core() -> None:
    """No database: the generator takes every code from ROLE_PERMISSIONS, and 0017 froze what it
    generated (for the codes it was generated with)."""
    assert gen_db_rules.platform_role_codes() == sorted(ROLE_PERMISSIONS)
    generated = gen_db_rules.platform_roles_sql()
    for code in ROLE_PERMISSIONS:
        assert f"NULL, '{code}', '{code}'," in generated
    frozen = FROZEN_0017.read_text()
    frozen_codes = sorted(line.split("'")[1] for line in frozen.splitlines()
                          if line.startswith("  (gen_random_uuid(), NULL, '"))
    assert gen_db_rules.platform_roles_sql(frozen_codes) in frozen


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_database_roles_are_exactly_cores(admin_engine: Engine) -> None:
    """Fails when core's ROLE_PERMISSIONS and the database's staff roles differ: write a new
    migration with gen_db_rules.platform_roles_sql() for the codes added (or retire the ones
    removed), never edit 0017."""
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT code, is_system, tenant_id FROM admin.role "
                              "WHERE tenant_id IS NULL ORDER BY code")).all()
        forced = c.execute(text("SELECT relforcerowsecurity FROM pg_class "
                                "WHERE oid = 'admin.role'::regclass")).scalar_one()
    assert [r.code for r in rows] == sorted(ROLE_PERMISSIONS)
    assert all(r.is_system for r in rows)
    assert forced  # 0017 forced RLS again after its insert


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_every_clinic_signs_in_with_them_and_none_can_change_them(
        admin_engine: Engine, app_engine: Engine) -> None:
    for tenant in (make_tenant(admin_engine), make_tenant(admin_engine)):
        with open_session(app_engine, tenant) as s:
            ctx = b.practice(s)  # its practitioner has a linked user
            s.commit()
            user, facility = ctx["user"].id, ctx["facility"].id
            role_id = s.execute(text("SELECT id FROM admin.role WHERE tenant_id IS NULL "
                                     "AND code = 'FD'")).scalar_one()
            s.execute(text("INSERT INTO admin.user_role (id, tenant_id, user_id, role_id, "
                           "facility_id) VALUES (gen_random_uuid(), :t, :u, :r, :f)"),
                      {"t": tenant, "u": user, "r": role_id, "f": facility})
            s.commit()
            # Core's own query at sign-in (app/core/session.py) finds the role.
            assert [tuple(r) for r in s.execute(CORE_ROLE_QUERY, {"id": user})] == [
                ("FD", facility)]
            changed = s.execute(text("UPDATE admin.role SET name = 'Mine' WHERE "
                                     "tenant_id IS NULL RETURNING id")).all()
            assert changed == []  # a clinic can't change a platform role
            s.rollback()
            with pytest.raises(DBAPIError, match="row-level security"):
                s.execute(text("INSERT INTO admin.role (id, tenant_id, code, name, is_system) "
                               "VALUES (gen_random_uuid(), NULL, 'XX', 'XX', true)"))
