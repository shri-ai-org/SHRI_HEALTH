"""Migration 0005: Thulasi's core tables and changes (issue #13, follow-up a).

Every test runs as the real role (SET ROLE from the superuser URL, see conftest.py), with forced
row-level security in force. Setup rows are written as the superuser. Tests that write audit
rows or outbox rows that other tests could see run in one transaction that is rolled back.
"""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant, switch_to_role, sync_url

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

ROLES = ("shri_app", "shri_fhir_reader", "shri_integration", "shri_reporting")
DENIED = "42501"
CHECK_FAILED = "23514"
UNIQUE_FAILED = "23505"
NEW_TABLES = {
    "admin.app_session": {"SELECT", "INSERT", "UPDATE", "DELETE"},
    "admin.idempotency_record": {"SELECT", "INSERT", "UPDATE", "DELETE"},
    "admin.operation": {"SELECT", "INSERT", "UPDATE", "DELETE"},
    "admin.event_log": {"SELECT", "INSERT", "DELETE"},
}
PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")


@pytest.fixture(scope="module")
def role_engine() -> Iterator[dict[str, Engine]]:
    engines: dict[str, Engine] = {}
    for role in ROLES:
        engine = create_engine(sync_url(), poolclass=NullPool)
        switch_to_role(engine, role, require_search_path=role != "shri_fhir_reader")
        engines[role] = engine
    yield engines
    for engine in engines.values():
        engine.dispose()


def with_clinic(conn: Connection, tenant: uuid.UUID | None) -> Connection:
    if tenant is not None:
        conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                     {"t": str(tenant)})
    return conn


def sqlstate(conn: Connection, sql: str, params: dict[str, object] | None = None) -> str | None:
    """The SQLSTATE a statement fails with, or None if it succeeds (undone either way)."""
    savepoint = conn.begin_nested()
    try:
        conn.execute(text(sql), params or {})
    except DBAPIError as err:
        savepoint.rollback()
        return getattr(err.orig, "sqlstate", None)
    savepoint.rollback()
    return None


def make_user(admin_engine: Engine, tenant: uuid.UUID) -> uuid.UUID:
    uid = uuid.uuid4()
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.app_user (id, tenant_id, display_name, "
                       "keycloak_subject, username) VALUES (:i, :t, 'Test User', :k, :u)"),
                  {"i": uid, "t": tenant, "k": str(uuid.uuid4()), "u": f"u-{uid.hex[:12]}"})
    return uid


def token_hash() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex


# =============================================================================== the new tables
@pytest.mark.parametrize("table", sorted(NEW_TABLES))
def test_new_table_is_clinic_isolated_and_only_the_api_may_use_it(admin_engine: Engine,
                                                                  table: str) -> None:
    with admin_engine.connect() as c:
        enabled, forced = c.execute(text(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE oid = CAST(:t AS regclass)"), {"t": table}).one()
        assert enabled and forced
        for role in ROLES:
            granted = {p for p in PRIVILEGES if c.execute(
                text("SELECT has_table_privilege(:r, :t, :p)"),
                {"r": role, "t": table, "p": p}).scalar_one()}
            assert granted == (NEW_TABLES[table] if role == "shri_app" else set()), role


def _insert_session(conn: Connection, tenant: uuid.UUID, user: uuid.UUID, token: str,
                    *, expires: timedelta = timedelta(hours=12),
                    idle: timedelta = timedelta(minutes=15), revoked: bool = False) -> None:
    now = datetime.now(UTC)
    conn.execute(text(
        "INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, csrf_token_hash, "
        "keycloak_access_token_enc, keycloak_refresh_token_enc, idle_expires_at, expires_at, "
        "revoked_at, created_at) "
        "VALUES (:i, :t, :u, :h, :c, 'enc:a', 'enc:r', :idle, :exp, :rev, :created)"),
        {"i": uuid.uuid4(), "t": tenant, "u": user, "h": token, "c": token_hash(),
         "idle": now + min(idle, expires), "exp": now + expires,
         "rev": now if revoked else None, "created": now - timedelta(hours=13)})


def test_sessions_are_clinic_isolated(admin_engine: Engine,
                                      role_engine: dict[str, Engine]) -> None:
    tenant, other = make_tenant(admin_engine), make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    token = token_hash()
    with role_engine["shri_app"].connect() as conn:
        _insert_session(with_clinic(conn, tenant), tenant, user, token)
        conn.commit()
        count = text("SELECT count(*) FROM admin.app_session WHERE token_hash = :h")
        assert with_clinic(conn, tenant).execute(count, {"h": token}).scalar_one() == 1
        conn.commit()
        assert with_clinic(conn, other).execute(count, {"h": token}).scalar_one() == 0
        conn.commit()
        assert conn.execute(count, {"h": token}).scalar_one() == 0          # no clinic set
        # Another clinic can neither change this session nor add one for this clinic.
        revoke = text("UPDATE admin.app_session SET revoked_at = now() WHERE token_hash = :h")
        assert with_clinic(conn, other).execute(revoke, {"h": token}).rowcount == 0
        assert sqlstate(conn, "INSERT INTO admin.app_session (id, tenant_id, user_id, "
                        "token_hash, csrf_token_hash, keycloak_access_token_enc, "
                        "keycloak_refresh_token_enc, idle_expires_at, expires_at) VALUES "
                        "(gen_random_uuid(), :t, :u, :h, :h, 'a', 'r', now(), now())",
                        {"t": tenant, "u": user, "h": token_hash()}) == DENIED


def test_session_token_hashes_must_be_sha256_hex(admin_engine: Engine,
                                                 role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        insert = ("INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
                  "csrf_token_hash, keycloak_access_token_enc, keycloak_refresh_token_enc, "
                  "idle_expires_at, expires_at) VALUES (gen_random_uuid(), :t, :u, :h, :c, "
                  "'a', 'r', now() + interval '15 minutes', now() + interval '12 hours')")
        good = {"t": tenant, "u": user, "h": token_hash(), "c": token_hash()}
        assert sqlstate(conn, insert, good) is None
        assert sqlstate(conn, insert, {**good, "h": "a-raw-token"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "c": "A" * 64}) == CHECK_FAILED


# ============================================================================ admin.lookup_session
def test_lookup_session_finds_live_sessions_of_any_clinic_before_one_is_set(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    t1, t2 = make_tenant(admin_engine), make_tenant(admin_engine)
    u1, u2 = make_user(admin_engine, t1), make_user(admin_engine, t2)
    live1, live2, revoked, expired, idle = (token_hash() for _ in range(5))
    with admin_engine.begin() as c:
        _insert_session(c, t1, u1, live1)
        _insert_session(c, t2, u2, live2)
        _insert_session(c, t1, u1, revoked, revoked=True)
        _insert_session(c, t1, u1, expired, expires=timedelta(seconds=-1))
        _insert_session(c, t1, u1, idle, idle=timedelta(seconds=-1))
    lookup = text("SELECT tenant_id, user_id FROM admin.lookup_session(:h)")
    with role_engine["shri_app"].connect() as conn:                      # no clinic set
        assert conn.execute(lookup, {"h": live1}).one() == (t1, u1)
        assert conn.execute(lookup, {"h": live2}).one() == (t2, u2)
        for dead in (revoked, expired, idle, token_hash()):
            assert conn.execute(lookup, {"h": dead}).first() is None
        # The function gives the IDs only; the table itself stays hidden without a clinic.
        assert conn.execute(text("SELECT count(*) FROM admin.app_session WHERE token_hash "
                                 "IN (:a, :b)"), {"a": live1, "b": live2}).scalar_one() == 0


@pytest.mark.parametrize(("function", "allowed"), [
    ("admin.lookup_session(text)", "shri_app"),
    ("admin.claim_outbound_messages(integer)", "shri_integration"),
])
def test_cross_clinic_functions_are_narrow(admin_engine: Engine, function: str,
                                           allowed: str) -> None:
    with admin_engine.connect() as c:
        definer, owner, config = c.execute(text(
            "SELECT p.prosecdef, pg_get_userbyid(p.proowner), p.proconfig FROM pg_proc p "
            "WHERE p.oid = CAST(:f AS regprocedure)"), {"f": function}).one()
        assert definer and owner == "shri_migrator"
        assert config == ["search_path=pg_catalog, pg_temp"]
        for role in ROLES:
            assert c.execute(text("SELECT has_function_privilege(:r, :f, 'EXECUTE')"),
                             {"r": role, "f": function}).scalar_one() == (role == allowed), role
        public_execute = c.execute(text(
            "SELECT count(*) FROM pg_proc p, aclexplode(coalesce(p.proacl, "
            "acldefault('f', p.proowner))) a WHERE p.oid = CAST(:f AS regprocedure) "
            "AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'"), {"f": function}).scalar_one()
        assert public_execute == 0


# ================================================================ admin.claim_outbound_messages
def _endpoint(conn: Connection, tenant: uuid.UUID) -> uuid.UUID:
    eid = uuid.uuid4()
    conn.execute(text("INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, "
                      "name, environment, baa_on_file, is_active) "
                      "VALUES (:i, :t, 'erx', 'test', 'Test e-prescribing', 'test', false, true)"),
                 {"i": eid, "t": tenant})
    return eid


def _message(conn: Connection, tenant: uuid.UUID, endpoint: uuid.UUID, *, key: str | None = None,
             status: str = "queued", direction: str = "outbound", age: int = 0,
             due_in: timedelta | None = None) -> uuid.UUID:
    mid = uuid.uuid4()
    created = datetime.now(UTC) - timedelta(minutes=10 - age)
    conn.execute(text(
        "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
        "message_type, status, ordering_key, payload, attempts, max_attempts, next_attempt_at, "
        "last_error, received_at, created_at) VALUES (:i, :t, :e, :d, 'NewRx', :s, :k, "
        "CAST('{\"prescriptionId\": \"x\"}' AS jsonb), 0, 5, :due, :err, :recv, :c)"),
        {"i": mid, "t": tenant, "e": endpoint, "d": direction, "s": status, "k": key,
         "due": None if due_in is None else datetime.now(UTC) + due_in,
         "err": "partner timeout" if status in ("failed", "dead-letter") else None,
         "recv": created if direction == "inbound" else None, "c": created})
    return mid


def _claim(conn: Connection, batch: int = 500) -> dict[uuid.UUID, uuid.UUID]:
    return {r.id: r.tenant_id for r in conn.execute(
        text("SELECT id, tenant_id FROM admin.claim_outbound_messages(:b)"), {"b": batch})}


def test_claim_takes_due_outbound_messages_of_every_clinic_in_key_order(
        admin_engine: Engine) -> None:
    """One transaction, rolled back: the claim sees every clinic's outbox, so nothing it could
    claim is left behind for other tests."""
    with admin_engine.connect() as conn:
        t1, t2 = uuid.uuid4(), uuid.uuid4()
        for t in (t1, t2):
            conn.execute(text("INSERT INTO admin.tenant (id, slug, name) VALUES "
                              "(:i, :s, 'Test practice')"), {"i": t, "s": f"t-{t.hex[:12]}"})
        e1, e2 = _endpoint(conn, t1), _endpoint(conn, t2)
        new_rx = _message(conn, t1, e1, key="rx-1", age=0)
        cancel_rx = _message(conn, t1, e1, key="rx-1", age=1)     # same key, newer: waits
        other_key = _message(conn, t1, e1, key="rx-2")
        no_key = _message(conn, t2, e2)
        retry_due = _message(conn, t2, e2, status="failed", due_in=timedelta(seconds=-1))
        retry_later = _message(conn, t2, e2, status="failed", due_in=timedelta(minutes=5))
        dead = _message(conn, t2, e2, status="dead-letter")
        inbound = _message(conn, t2, e2, direction="inbound", status="received")
        conn.execute(text("SET LOCAL ROLE shri_integration"))     # no clinic set

        first = _claim(conn)
        assert {new_rx: t1, other_key: t1, no_key: t2, retry_due: t2}.items() <= first.items()
        assert not {cancel_rx, retry_later, dead, inbound} & first.keys()
        assert _claim(conn).keys().isdisjoint({cancel_rx})        # NewRx still 'sending'

        conn.execute(text("RESET ROLE"))
        status = text("SELECT status FROM admin.integration_message WHERE id = :i")
        assert conn.execute(status, {"i": new_rx}).scalar_one() == "sending"
        conn.execute(text("UPDATE admin.integration_message SET status = 'sent', "
                          "sent_at = now() WHERE id = :i"), {"i": new_rx})
        conn.execute(text("SET LOCAL ROLE shri_integration"))
        assert _claim(conn).get(cancel_rx) == t1                  # now the CancelRx goes
        conn.rollback()


def test_claim_skips_rows_another_worker_holds(admin_engine: Engine,
                                               role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    with admin_engine.begin() as c:
        endpoint = _endpoint(c, tenant)
        first = _message(c, tenant, endpoint, key="rx-9", age=0)
        second = _message(c, tenant, endpoint, key="rx-9", age=1)
        loose = [_message(c, tenant, endpoint, age=2 + i) for i in range(2)]
    ours = {first, second, *loose}
    try:
        with role_engine["shri_integration"].connect() as w1, \
                role_engine["shri_integration"].connect() as w2:
            got1 = _claim(w1).keys() & ours                  # w1 holds its rows, uncommitted
            got2 = _claim(w2).keys() & ours
            assert got1.isdisjoint(got2)
            assert second not in got1 | got2                 # its key's older row is in flight
            assert got1 | got2 == {first, *loose}
            w1.commit()
            w2.commit()
    finally:
        with admin_engine.begin() as c:                      # leave nothing claimable behind
            c.execute(text("DELETE FROM admin.integration_message WHERE id = ANY(:i)"),
                      {"i": list(ours)})


@pytest.mark.parametrize("batch", [0, -1, 501])
def test_claim_batch_is_bounded(role_engine: dict[str, Engine], batch: int) -> None:
    with role_engine["shri_integration"].connect() as conn:
        assert sqlstate(conn, "SELECT * FROM admin.claim_outbound_messages(:b)",
                        {"b": batch}) == "22023"


# ============================================================ A47: clinic-less security events
PLATFORM_EVENT = ("INSERT INTO audit.audit_event (tenant_id, actor_type, action, category, "
                  "outcome, reason) VALUES (NULL, 'system', :a, :c, 'failure', 'unknown user')")


def test_api_writes_clinic_less_security_events_and_the_chain_numbers_them(
        admin_engine: Engine) -> None:
    """One transaction, rolled back: audit rows can never be deleted."""
    with admin_engine.connect() as conn:
        before = conn.execute(text("SELECT coalesce(max(chain_seq), 0) FROM audit.audit_event "
                                   "WHERE tenant_id IS NULL")).scalar_one()
        conn.execute(text("SET LOCAL ROLE shri_app"))           # no clinic set
        conn.execute(text(PLATFORM_EVENT), {"a": "login", "c": "security"})
        conn.execute(text(PLATFORM_EVENT), {"a": "access-denied", "c": "security"})
        # Written, but not readable by the clinic API.
        assert conn.execute(text("SELECT count(*) FROM audit.audit_event "
                                 "WHERE tenant_id IS NULL")).scalar_one() == 0
        conn.execute(text("RESET ROLE"))
        seqs = conn.execute(text("SELECT chain_seq FROM audit.audit_event WHERE tenant_id IS "
                                 "NULL AND chain_seq > :b ORDER BY chain_seq"),
                            {"b": before}).scalars().all()
        assert seqs == [before + 1, before + 2]
        assert conn.execute(text("SELECT count(*) FROM shri_audit_verify(NULL)")).scalar_one() == 0
        conn.rollback()


@pytest.mark.parametrize(("action", "category"), [
    ("read", "phi-read"),          # not a security event
    ("read", "security"),          # security, but not an approved action
    ("logout", "security"),        # a sign-out always has a clinic
    ("login", "admin"),
])
def test_other_clinic_less_events_are_refused(admin_engine: Engine, action: str,
                                              category: str) -> None:
    tenant = make_tenant(admin_engine)
    with admin_engine.connect() as conn:
        conn.execute(text("SET LOCAL ROLE shri_app"))
        for clinic in (None, tenant):
            with_clinic(conn, clinic)
            assert sqlstate(conn, PLATFORM_EVENT, {"a": action, "c": category}) == DENIED
        conn.rollback()


@pytest.mark.parametrize("role", ["shri_fhir_reader", "shri_integration"])
def test_only_the_api_writes_clinic_less_events(admin_engine: Engine, role: str) -> None:
    with admin_engine.connect() as conn:
        conn.execute(text(f"SET LOCAL ROLE {role}"))
        assert sqlstate(conn, PLATFORM_EVENT, {"a": "login", "c": "security"}) == DENIED
        conn.rollback()


def test_api_cannot_read_back_a_clinic_less_event(admin_engine: Engine) -> None:
    # RETURNING needs the row to pass a SELECT policy, and none lets shri_app see it.
    with admin_engine.connect() as conn:
        conn.execute(text("SET LOCAL ROLE shri_app"))
        assert sqlstate(conn, PLATFORM_EVENT + " RETURNING id",
                        {"a": "login", "c": "security"}) == DENIED
        conn.rollback()


def test_every_audit_event_has_a_category(admin_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    with admin_engine.connect() as conn:
        with_clinic(conn, tenant)
        insert = ("INSERT INTO audit.audit_event (tenant_id, actor_type, action, outcome{c}) "
                  "VALUES (:t, 'system', 'read', 'success'{v})")
        assert sqlstate(conn, insert.format(c="", v=""), {"t": tenant}) == "23502"
        assert sqlstate(conn, insert.format(c=", category", v=", 'phi'"),
                        {"t": tenant}) == CHECK_FAILED
        conn.rollback()


# ========================================================================= break-glass (D53)
@pytest.mark.parametrize(("code", "reason", "refused"), [
    ("emergency-care", None, None),
    ("continuity-of-care", None, None),
    ("patient-request", "Patient asked at the desk", None),
    ("other", "Covering for a colleague", None),
    ("other", None, CHECK_FAILED),
    ("other", "   ", CHECK_FAILED),
    ("curiosity", "Just looking", CHECK_FAILED),
])
def test_break_glass_reason_follows_the_contract(admin_engine: Engine, code: str,
                                                 reason: str | None, refused: str | None) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    patient = uuid.uuid4()
    with admin_engine.connect() as conn:
        conn.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        with_clinic(conn, tenant)
        conn.execute(text("INSERT INTO clinical.patient (id, tenant_id, gender) "
                          "VALUES (:i, :t, 'unknown')"), {"i": patient, "t": tenant})
        conn.execute(text("SET LOCAL ROLE shri_app"))
        assert sqlstate(conn, "INSERT INTO audit.break_glass_access (id, tenant_id, patient_id, "
                        "user_id, reason_code, reason_text, granted_at, expires_at) VALUES "
                        "(gen_random_uuid(), :t, :p, :u, :c, :r, now(), "
                        "now() + interval '4 hours')",
                        {"t": tenant, "p": patient, "u": user, "c": code,
                         "r": reason}) == refused
        conn.rollback()


# ========================================================= idempotency records and operations
def test_idempotency_record_rules(admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    insert = ("INSERT INTO admin.idempotency_record (id, tenant_id, user_id, method, path, key, "
              "request_hash, state, response_status, expires_at) VALUES (gen_random_uuid(), "
              ":t, :u, :m, '/api/v1/patients', :k, :h, :s, :rs, now() + interval '24 hours')")
    good = {"t": tenant, "u": user, "m": "POST", "k": "k-1", "h": token_hash(), "s": "done",
            "rs": 201}
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        assert sqlstate(conn, insert, good) is None
        assert sqlstate(conn, insert, {**good, "m": "GET"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "rs": None}) == CHECK_FAILED    # done, no status
        assert sqlstate(conn, insert, {**good, "s": "in-progress", "rs": None}) is None
        for not_stored in (500, 503, 429):
            assert sqlstate(conn, insert, {**good, "rs": not_stored}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "h": "not-a-hash"}) == CHECK_FAILED
        conn.execute(text(insert), good)
        assert sqlstate(conn, insert, good) == UNIQUE_FAILED                  # same key reused
        conn.rollback()


def test_operation_rules(admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    insert = ("INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, status, "
              "error, completed_at, result_type, result_id) VALUES (gen_random_uuid(), :t, :u, "
              "'export', :s, CAST(:e AS jsonb), :done, :rt, :ri)")
    good = {"t": tenant, "u": user, "s": "queued", "e": None, "done": None, "rt": None,
            "ri": None}
    finished = datetime.now(UTC)
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        assert sqlstate(conn, insert, good) is None
        assert sqlstate(conn, insert, {**good, "u": None}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "done": finished}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "succeeded"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "failed", "done": finished}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "failed", "done": finished,
                                       "e": '{"type": "about:blank"}'}) is None
        assert sqlstate(conn, insert, {**good, "rt": "Binary"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "running"}) is None
        conn.rollback()


def test_events_are_written_once(admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(text("INSERT INTO admin.event_log (id, tenant_id, type, subject, data) "
                          "VALUES (gen_random_uuid(), :t, 'appointment.updated', "
                          "'appointment/x', '{}')"), {"t": tenant})
        assert sqlstate(conn, "UPDATE admin.event_log SET type = 'x' WHERE tenant_id = :t",
                        {"t": tenant}) == DENIED
        assert sqlstate(conn, "DELETE FROM admin.event_log WHERE tenant_id = :t",
                        {"t": tenant}) is None
        conn.rollback()
