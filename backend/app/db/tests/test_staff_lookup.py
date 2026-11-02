"""Migration 0016: staff sign-in finds a Keycloak subject's user and clinic before a clinic is
known (core's login callback). Runs as shri_app with no clinic set, as the callback does.
Synthetic data only."""
from __future__ import annotations

import uuid
from collections.abc import Iterator

import pytest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import (
    SERVICE_ROLES,
    SKIP_WITHOUT_DATABASE,
    make_tenant,
    switch_to_role,
    sync_url,
)

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

LOOKUP = text("SELECT * FROM admin.lookup_staff_user(:k)")


@pytest.fixture(scope="module")
def app_conn_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    yield engine
    engine.dispose()


def _user(admin_engine: Engine, tenant: uuid.UUID | None, *, active: bool = True) -> str:
    subject, uid = str(uuid.uuid4()), uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.app_user (id, tenant_id, display_name, "
                       "keycloak_subject, username, is_active) VALUES (:i, :t, 'Test User', :k, "
                       ":u, :a)"), {"i": uid, "t": tenant, "k": subject,
                                    "u": f"u-{uid.hex[:12]}", "a": active})
    return subject


def test_a_subject_gives_its_user_clinic_and_active_flag(admin_engine: Engine,
                                                         app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    active, inactive = _user(admin_engine, tenant), _user(admin_engine, tenant, active=False)
    platform = _user(admin_engine, None)
    with app_conn_engine.connect() as c:                 # no clinic set, as at the callback
        found = c.execute(LOOKUP, {"k": active}).one()
        assert (found.tenant_id, found.is_active) == (tenant, True)
        assert c.execute(LOOKUP, {"k": inactive}).one().is_active is False   # core refuses
        assert c.execute(LOOKUP, {"k": platform}).one().tenant_id is None    # core refuses
        assert c.execute(LOOKUP, {"k": str(uuid.uuid4())}).first() is None
        # The lookup doesn't open the table: without a clinic, shri_app still sees no user.
        assert c.execute(text("SELECT count(*) FROM admin.app_user WHERE tenant_id = :t"),
                         {"t": tenant}).scalar_one() == 0


def test_the_lookup_runs_as_its_owner_for_shri_app_only(admin_engine: Engine) -> None:
    function = "admin.lookup_staff_user(text)"
    with admin_engine.connect() as c:
        definer, config, owner = c.execute(text(
            "SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) FROM pg_proc p "
            "WHERE p.oid = CAST(:f AS regprocedure)"), {"f": function}).one()
        assert definer and owner == "shri_migrator"
        assert config == ["search_path=pg_catalog, pg_temp"]
        for role in SERVICE_ROLES:
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": function}).scalar_one() == (role == "shri_app")
        assert c.execute(text("SELECT has_function_privilege('public', :f, 'EXECUTE')"),
                         {"f": function}).scalar_one() is False


def test_only_the_migrator_gains_a_read_policy(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        roles = c.execute(text("SELECT roles::text[] FROM pg_policies WHERE schemaname = 'admin' "
                               "AND tablename = 'app_user' AND policyname = "
                               "'migrator_staff_lookup'")).scalar_one()
        assert roles == ["shri_migrator"]
