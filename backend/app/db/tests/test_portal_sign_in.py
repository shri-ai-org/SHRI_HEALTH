"""Migration 0011: the portal's sign-in tables and functions, and the staff back-channel logout
(ADR-0013 §3 and §5, D92, D94). shri_app by SET ROLE from the superuser URL (see conftest.py),
with forced row-level security in force. Synthetic data only."""
from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool

from app.db.tests import builders as b
from app.db.tests.conftest import (
    SERVICE_ROLES,
    SKIP_WITHOUT_DATABASE,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.db.tests.test_core_runtime import make_user, token_hash, with_clinic

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

ENC = "vault:v1:c2VjcmV0"
DOB = dt.date(1984, 3, 9)                   # builders.patient's date of birth


@pytest.fixture(scope="module")
def app_conn_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    yield engine
    engine.dispose()


def _patient(app_engine: Engine, tenant: uuid.UUID) -> uuid.UUID:
    s = open_session(app_engine, tenant)
    pid: uuid.UUID = b.patient(s).id
    s.commit()
    conn = s.bind
    s.close()
    conn.close()  # type: ignore[union-attr]
    return pid


def _invite(c: Connection, tenant: uuid.UUID, patient: uuid.UUID, user: uuid.UUID,
            hours: int = 72) -> str:
    code = token_hash()
    c.execute(text("INSERT INTO admin.portal_invitation (id, tenant_id, patient_id, code_hmac, "
                   "issued_by_user_id, expires_at, created_at) VALUES (gen_random_uuid(), :t, "
                   ":p, :h, :u, now() + make_interval(hours => :x), "
                   "now() + make_interval(hours => :x - 72))"),
              {"t": tenant, "p": patient, "h": code, "u": user, "x": hours})
    return code


def _account(c: Connection, tenant: uuid.UUID, patient: uuid.UUID,
             status: str = "active") -> tuple[uuid.UUID, str]:
    aid, kc = uuid.uuid4(), f"kc-{uuid.uuid4()}"
    extra = {"disabled": ", enrolled_at, disabled_at, disabled_reason",
             "active": ", enrolled_at"}.get(status, "")
    vals = {"disabled": ", now(), now(), 'Misuse reported'", "active": ", now()"}.get(status, "")
    c.execute(text(f"INSERT INTO admin.portal_account (id, tenant_id, keycloak_user_id, "
                   f"patient_id, status{extra}) VALUES (:i, :t, :k, :p, :s{vals})"),
              {"i": aid, "t": tenant, "k": kc, "p": patient, "s": status})
    return aid, kc


def _portal_session(c: Connection, tenant: uuid.UUID, account: uuid.UUID, patient: uuid.UUID,
                    *, hours: int = 4, idle_minutes: int = 15) -> str:
    h = token_hash()
    c.execute(text("INSERT INTO admin.portal_session (id, tenant_id, account_id, patient_id, "
                   "token_hash, keycloak_access_token_enc, keycloak_refresh_token_enc, "
                   "idle_expires_at, expires_at) VALUES (gen_random_uuid(), :t, :a, :p, :h, :e, "
                   ":e, now() + make_interval(mins => :i), now() + make_interval(hours => :x))"),
              {"t": tenant, "a": account, "p": patient, "h": h, "e": ENC, "i": idle_minutes,
               "x": hours})
    return h


def _staff_session(c: Connection, tenant: uuid.UUID, user: uuid.UUID,
                   sid: str | None = None) -> uuid.UUID:
    sid_ = uuid.uuid4()
    c.execute(text("INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
                   "keycloak_access_token_enc, keycloak_refresh_token_enc, keycloak_sid, "
                   "idle_expires_at, expires_at) VALUES (:i, :t, :u, :h, :e, :e, :s, "
                   "now() + interval '15 minutes', now() + interval '12 hours')"),
              {"i": sid_, "t": tenant, "u": user, "h": token_hash(), "e": ENC, "s": sid})
    return sid_


def _fails(conn: Connection, sql: str, params: dict[str, Any]) -> Any:
    with pytest.raises(DBAPIError) as err:
        conn.execute(text(sql), params)
    conn.rollback()
    return err.value.orig


# ========================================================================= the tables
@pytest.mark.parametrize("table", ["portal_invitation", "portal_account", "portal_session"])
def test_shri_app_reads_and_writes_but_never_deletes(admin_engine: Engine, table: str) -> None:
    with admin_engine.connect() as c:
        privs = {p for p in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE") if
                 c.execute(text("SELECT has_table_privilege('shri_app', :t, :p)"),
                           {"t": f"admin.{table}", "p": p}).scalar_one()}
        assert privs == {"SELECT", "INSERT", "UPDATE"}
        others = [r for r in SERVICE_ROLES if r != "shri_app"]
        for role in others:
            assert not c.execute(text("SELECT has_table_privilege(:r, :t, 'SELECT')"),
                                 {"r": role, "t": f"admin.{table}"}).scalar_one(), role


def test_no_role_touches_the_used_logout_tokens(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        for role in SERVICE_ROLES:
            for p in ("SELECT", "INSERT", "UPDATE", "DELETE"):
                assert not c.execute(text("SELECT has_table_privilege(:r, "
                                          "'admin.consumed_logout_token', :p)"),
                                     {"r": role, "p": p}).scalar_one(), (role, p)


def test_one_open_invitation_per_patient_and_an_account_keeps_its_patient(
        admin_engine: Engine, app_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user, patient = make_user(admin_engine, tenant), _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        _invite(c, tenant, patient, user)
        c.commit()
        with_clinic(c, tenant)
        err = _fails(c, "INSERT INTO admin.portal_invitation (id, tenant_id, patient_id, "
                     "code_hmac, issued_by_user_id, expires_at) VALUES (gen_random_uuid(), :t, "
                     ":p, :h, :u, now() + interval '1 day')",
                     {"t": tenant, "p": patient, "h": token_hash(), "u": user})
        assert err.diag.constraint_name == "uq_portal_invitation_one_open"
        with_clinic(c, tenant)
        aid, _ = _account(c, tenant, patient)
        c.commit()
        with_clinic(c, tenant)
        err = _fails(c, "UPDATE admin.portal_account SET patient_id = :p WHERE id = :a",
                     {"p": _patient(app_engine, tenant), "a": aid})
        assert err.sqlstate == "P0001"


@pytest.mark.parametrize(("sets", "constraint"), [
    ("status = 'disabled'", "ck_portal_account_disabled_has_time_and_reason"),
    ("status = 'disabled', disabled_at = now(), disabled_reason = ' '",
     "ck_portal_account_disabled_has_time_and_reason"),
    ("status = 'suspended', status_before_suspension = 'active'",
     "ck_portal_account_suspended_has_origin"),
])
def test_an_account_state_carries_what_explains_it(admin_engine: Engine, app_engine: Engine,
                                                   app_conn_engine: Engine, sets: str,
                                                   constraint: str) -> None:
    tenant = make_tenant(admin_engine)
    patient = _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        aid, _ = _account(c, tenant, patient)
        c.commit()
        with_clinic(c, tenant)
        err = _fails(c, f"UPDATE admin.portal_account SET {sets} WHERE id = :a", {"a": aid})
        assert err.diag.constraint_name == constraint


# ===================================================================== the lookups
def test_a_portal_session_is_found_only_while_live_and_its_account_active(
        admin_engine: Engine, app_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    patient = _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        aid, _ = _account(c, tenant, patient)
        live = _portal_session(c, tenant, aid, patient)
        idle = _portal_session(c, tenant, aid, patient, idle_minutes=-1)
        c.commit()
    with app_conn_engine.connect() as c:               # no clinic set
        lookup = text("SELECT * FROM admin.lookup_portal_session(:h)")
        assert tuple(c.execute(lookup, {"h": live}).one())[1:] == (tenant, patient)
        assert c.execute(lookup, {"h": idle}).first() is None
        assert c.execute(text("SELECT * FROM admin.lookup_session(:h)"),
                         {"h": live}).first() is None       # never a staff session
        c.rollback()
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        c.execute(text("UPDATE admin.portal_account SET status = 'disabled', disabled_at = "
                       "now(), disabled_reason = 'Misuse reported' WHERE id = :a"), {"a": aid})
        c.commit()
        assert c.execute(lookup, {"h": live}).first() is None


@pytest.mark.parametrize(("status", "found"), [("pending-setup", True), ("active", True),
                                               ("disabled", False)])
def test_the_callback_finds_only_a_live_account(admin_engine: Engine, app_engine: Engine,
                                                app_conn_engine: Engine, status: str,
                                                found: bool) -> None:
    tenant = make_tenant(admin_engine)
    patient = _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        aid, kc = _account(c, tenant, patient, status)
        c.commit()
    with app_conn_engine.connect() as c:
        row = c.execute(text("SELECT * FROM admin.lookup_portal_account(:k)"), {"k": kc}).first()
        assert (row is not None) == found
        if row is not None:
            assert (row.account_id, row.tenant_id, row.patient_id, row.status) == (
                aid, tenant, patient, status)


def test_an_invitation_is_redeemed_once_with_the_right_date_of_birth(
        admin_engine: Engine, app_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user, patient = make_user(admin_engine, tenant), _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        code = _invite(c, tenant, patient, user)
        c.commit()
    redeem = text("SELECT * FROM admin.redeem_portal_invitation(:h, :d)")
    with app_conn_engine.connect() as c:               # no clinic set, as at enrolment
        assert c.execute(redeem, {"h": code, "d": DOB - dt.timedelta(days=1)}).first() is None
        c.commit()                                        # the failed try counts
        row = c.execute(redeem, {"h": code, "d": DOB}).one()
        c.commit()
        assert (row.tenant_id, row.patient_id) == (tenant, patient)
        assert c.execute(redeem, {"h": code, "d": DOB}).first() is None   # single use
        assert c.execute(redeem, {"h": token_hash(), "d": DOB}).first() is None
        c.commit()
    with admin_engine.connect() as c:
        inv = c.execute(text("SELECT failed_tries, used_at FROM admin.portal_invitation "
                             "WHERE id = :i"), {"i": row.invitation_id}).one()
    assert inv.failed_tries == 1 and inv.used_at is not None


def test_the_fifth_wrong_date_of_birth_revokes_the_invitation(
        admin_engine: Engine, app_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user, patient = make_user(admin_engine, tenant), _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        code = _invite(c, tenant, patient, user)
        c.commit()
    redeem = text("SELECT * FROM admin.redeem_portal_invitation(:h, :d)")
    with app_conn_engine.connect() as c:
        for _ in range(5):
            assert c.execute(redeem, {"h": code, "d": dt.date(2000, 1, 1)}).first() is None
            c.commit()
        assert c.execute(redeem, {"h": code, "d": DOB}).first() is None
    with admin_engine.connect() as c:
        inv = c.execute(text("SELECT failed_tries, revoked_at FROM admin.portal_invitation "
                             "WHERE code_hmac = :h"), {"h": code}).one()
    assert inv.failed_tries == 5 and inv.revoked_at is not None


def test_the_lookups_reveal_nothing_else(admin_engine: Engine, app_engine: Engine,
                                         app_conn_engine: Engine) -> None:
    """After the functions run, the tables stay hidden without a clinic."""
    tenant = make_tenant(admin_engine)
    user, patient = make_user(admin_engine, tenant), _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        _invite(c, tenant, patient, user)
        c.commit()
    with app_conn_engine.connect() as c:
        for table in ("admin.portal_invitation", "admin.portal_account", "admin.portal_session",
                      "clinical.patient"):
            assert c.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0, table


# ============================================================= the back-channel logout
END = text("SELECT * FROM admin.end_backchannel_sessions(:j, now() + interval '2 minutes', "
           ":s, :u)")


def test_a_logout_token_with_a_sid_ends_that_session_only(
        admin_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        mine = _staff_session(c, tenant, user, "kc-sid-1")
        other = _staff_session(c, tenant, user)
        c.commit()
    with app_conn_engine.connect() as c:                 # no clinic: the hook knows none
        ended = c.execute(END, {"j": str(uuid.uuid4()), "s": "kc-sid-1", "u": None}).all()
        c.commit()
    assert [(r.session_id, r.tenant_id, r.user_id) for r in ended] == [(mine, tenant, user)]
    with admin_engine.connect() as c:
        revoked: dict[uuid.UUID, bool] = {r.id: r.ended for r in c.execute(text(
            "SELECT id, revoked_at IS NOT NULL AS ended FROM admin.app_session "
            "WHERE id IN (:a, :b)"), {"a": mine, "b": other})}
    assert revoked == {mine: True, other: False}


def test_a_logout_token_with_only_sub_ends_every_session_of_the_user(
        admin_engine: Engine, app_conn_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user, someone = make_user(admin_engine, tenant), make_user(admin_engine, tenant)
    with admin_engine.connect() as c:
        subject = c.execute(text("SELECT keycloak_subject FROM admin.app_user WHERE id = :u"),
                            {"u": user}).scalar_one()
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        theirs = {_staff_session(c, tenant, user), _staff_session(c, tenant, user)}
        _staff_session(c, tenant, someone)
        c.commit()
    with app_conn_engine.connect() as c:
        ended = c.execute(END, {"j": str(uuid.uuid4()), "s": None, "u": subject}).all()
        c.commit()
    assert {r.session_id for r in ended} == theirs


def test_a_logout_token_is_used_once(admin_engine: Engine, app_conn_engine: Engine) -> None:
    jti = str(uuid.uuid4())
    with app_conn_engine.connect() as c:
        c.execute(END, {"j": jti, "s": "kc-none", "u": None})
        c.commit()
        err = _fails(c, "SELECT * FROM admin.end_backchannel_sessions(:j, now(), :s, NULL)",
                     {"j": jti, "s": "kc-none"})
    assert err.sqlstate == "P0001" and err.diag.constraint_name == "logout_token_replayed"


@pytest.mark.parametrize(("jti", "sid", "sub"), [(None, "kc-1", None), ("j", None, None),
                                                 ("j", "", "")])
def test_a_logout_token_must_name_itself_and_a_session_or_user(
        app_conn_engine: Engine, jti: str | None, sid: str | None, sub: str | None) -> None:
    with app_conn_engine.connect() as c:
        err = _fails(c, "SELECT * FROM admin.end_backchannel_sessions(:j, now(), :s, :u)",
                     {"j": jti, "s": sid, "u": sub})
    assert err.sqlstate == "22023"


# ======================================================================== retention
def test_the_purge_removes_spent_portal_rows_and_expired_logout_tokens(
        admin_engine: Engine, app_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user, patient = make_user(admin_engine, tenant), _patient(app_engine, tenant)
    with admin_engine.begin() as c:                       # the superuser, for old rows
        aid, _ = _account(c, tenant, patient)
        old = _portal_session(c, tenant, aid, patient, hours=-25, idle_minutes=-26 * 60)
        live = _portal_session(c, tenant, aid, patient)
        spent = _invite(c, tenant, patient, user, hours=-25)
        c.execute(text("INSERT INTO admin.consumed_logout_token (id, jti, expires_at) VALUES "
                       "(gen_random_uuid(), :a, now() - interval '1 minute'), "
                       "(gen_random_uuid(), :b, now() + interval '1 minute')"),
                  {"a": f"old-{uuid.uuid4()}", "b": f"new-{uuid.uuid4()}"})
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_maintenance", require_search_path=False)
    with engine.connect() as conn:
        deleted = {r.table_name: r.deleted for r in conn.execute(text(
            "SELECT table_name, deleted FROM admin.purge_expired_runtime_rows()"))}
        conn.commit()
    engine.dispose()
    assert deleted["portal_session"] >= 1 and deleted["portal_invitation"] >= 1
    assert deleted["consumed_logout_token"] >= 1
    with admin_engine.connect() as c:
        left = set(c.execute(text("SELECT token_hash FROM admin.portal_session WHERE "
                                  "tenant_id = :t"), {"t": tenant}).scalars())
        assert left == {live} and old not in left
        assert not c.execute(text("SELECT 1 FROM admin.portal_invitation WHERE code_hmac = :h"),
                             {"h": spent}).first()
