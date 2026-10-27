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

ROLES = ("shri_app", "shri_fhir_reader", "shri_integration", "shri_reporting",
         "shri_maintenance")
#: Roles with no search_path setting of their own.
NO_SEARCH_PATH = {"shri_fhir_reader", "shri_maintenance"}
DENIED = "42501"
CHECK_FAILED = "23514"
UNIQUE_FAILED = "23505"
# Table-level privileges. No role deletes from these tables: only the purge function does.
# shri_integration's column-level grants on admin.operation are tested separately.
NEW_TABLES = {
    "admin.app_session": {"shri_app": {"SELECT", "INSERT", "UPDATE"}},
    "admin.idempotency_record": {"shri_app": {"SELECT", "INSERT", "UPDATE"}},
    "admin.operation": {"shri_app": {"SELECT", "INSERT", "UPDATE"}},
    "admin.event_log": {"shri_app": {"SELECT", "INSERT"}, "shri_integration": {"INSERT"}},
}
PRIVILEGES = ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER")


@pytest.fixture(scope="module")
def role_engine() -> Iterator[dict[str, Engine]]:
    engines: dict[str, Engine] = {}
    for role in ROLES:
        engine = create_engine(sync_url(), poolclass=NullPool)
        switch_to_role(engine, role, require_search_path=role not in NO_SEARCH_PATH)
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
def test_new_table_is_clinic_isolated_and_only_the_named_roles_may_use_it(
        admin_engine: Engine, table: str) -> None:
    with admin_engine.connect() as c:
        enabled, forced = c.execute(text(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE oid = CAST(:t AS regclass)"), {"t": table}).one()
        assert enabled and forced
        for role in ROLES:
            granted = {p for p in PRIVILEGES if c.execute(
                text("SELECT has_table_privilege(:r, :t, :p)"),
                {"r": role, "t": table, "p": p}).scalar_one()}
            assert granted == NEW_TABLES[table].get(role, set()), role


def _insert_session(conn: Connection, tenant: uuid.UUID, user: uuid.UUID, token: str,
                    *, expires: timedelta = timedelta(hours=12),
                    idle: timedelta = timedelta(minutes=15), revoked: bool = False) -> None:
    now = datetime.now(UTC)
    conn.execute(text(
        "INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
        "keycloak_access_token_enc, keycloak_refresh_token_enc, idle_expires_at, expires_at, "
        "revoked_at, created_at) "
        "VALUES (:i, :t, :u, :h, 'vault:v1:YQ==', 'vault:v1:cg==', :idle, :exp, :rev, :created)"),
        {"i": uuid.uuid4(), "t": tenant, "u": user, "h": token,
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
                        "token_hash, keycloak_access_token_enc, "
                        "keycloak_refresh_token_enc, idle_expires_at, expires_at) VALUES "
                        "(gen_random_uuid(), :t, :u, :h, 'vault:v1:YQ==', 'vault:v1:cg==', "
                        "now(), now())",
                        {"t": tenant, "u": user, "h": token_hash()}) == DENIED


def test_session_token_is_a_sha256_hash_and_no_csrf_token_is_stored(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        insert = ("INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
                  "keycloak_access_token_enc, keycloak_refresh_token_enc, "
                  "idle_expires_at, expires_at) VALUES (gen_random_uuid(), :t, :u, :h, "
                  ":a, 'vault:v3:cg==', now() + interval '15 minutes', "
                  "now() + interval '12 hours')")
        good = {"t": tenant, "u": user, "h": token_hash(), "a": "vault:v12:YQ=="}
        assert sqlstate(conn, insert, good) is None
        assert sqlstate(conn, insert, {**good, "h": "a-raw-token"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "h": "A" * 64}) == CHECK_FAILED
        # Keycloak tokens only as OpenBao Transit ciphertext, never plain text by mistake.
        for plain in ("eyJhbGciOiJSUzI1NiJ9.x.y", "vault:vX:YQ==", ""):
            assert sqlstate(conn, insert, {**good, "a": plain}) == CHECK_FAILED, plain
    with admin_engine.connect() as c:   # core derives the CSRF token from the session (B1)
        assert c.execute(text("SELECT count(*) FROM information_schema.columns WHERE "
                              "table_schema = 'admin' AND table_name = 'app_session' AND "
                              "column_name LIKE 'csrf%'")).scalar_one() == 0


def test_a_session_keeps_keycloaks_session_id_for_back_channel_logout(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    # D94, Thulasi on #80: a logout token's sid ends just that session, found by this index.
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    sid = str(uuid.uuid4())
    with role_engine["shri_app"].begin() as conn:
        with_clinic(conn, tenant)
        conn.execute(text(
            "INSERT INTO admin.app_session (id, tenant_id, user_id, token_hash, "
            "keycloak_access_token_enc, keycloak_refresh_token_enc, keycloak_sid, "
            "idle_expires_at, expires_at) VALUES (gen_random_uuid(), :t, :u, :h, "
            "'vault:v1:YQ==', 'vault:v1:cg==', :s, now() + interval '15 minutes', "
            "now() + interval '12 hours')"),
            {"t": tenant, "u": user, "h": token_hash(), "s": sid})
        assert conn.execute(text("SELECT count(*) FROM admin.app_session WHERE keycloak_sid = "
                                 ":s"), {"s": sid}).scalar_one() == 1
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT indexdef FROM pg_indexes WHERE schemaname = 'admin' AND "
                              "indexname = 'ix_app_session_keycloak_sid'")).scalar_one().endswith(
            "(keycloak_sid)")


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
    ("admin.purge_expired_runtime_rows()", "shri_maintenance"),
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
             due_in: timedelta | None = None, attempts: int = 0,
             claimed: timedelta | None = None) -> uuid.UUID:
    """``claimed``: how long ago a ``sending`` row was claimed."""
    mid = uuid.uuid4()
    created = datetime.now(UTC) - timedelta(minutes=30 - age)
    conn.execute(text(
        "INSERT INTO admin.integration_message (id, tenant_id, endpoint_id, direction, "
        "message_type, status, ordering_key, payload, attempts, max_attempts, next_attempt_at, "
        "last_error, received_at, created_at, claimed_at) VALUES (:i, :t, :e, :d, 'NewRx', :s, "
        ":k, CAST('{\"prescriptionId\": \"x\"}' AS jsonb), :a, 5, :due, :err, :recv, :c, :cl)"),
        {"i": mid, "t": tenant, "e": endpoint, "d": direction, "s": status, "k": key,
         "a": attempts, "due": None if due_in is None else datetime.now(UTC) + due_in,
         "err": "partner timeout" if status in ("failed", "dead-letter") else None,
         "recv": created if direction == "inbound" else None, "c": created,
         "cl": None if claimed is None else datetime.now(UTC) - claimed})
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


def test_claim_respects_dead_letters_attempts_and_the_lease(admin_engine: Engine) -> None:
    """Thulasi's and Vimal's reviews of #52: a dead letter holds its ordering key until someone
    resolves it; a row with no attempts left is never claimed; a `sending` row whose worker died
    is claimable again once its 15-minute lease has run out, and not before. One transaction,
    rolled back."""
    with admin_engine.connect() as conn:
        tenant = uuid.uuid4()
        conn.execute(text("INSERT INTO admin.tenant (id, slug, name) VALUES "
                          "(:i, :s, 'Test practice')"), {"i": tenant, "s": f"t-{tenant.hex[:12]}"})
        e = _endpoint(conn, tenant)
        dead_new_rx = _message(conn, tenant, e, key="rx-1", status="dead-letter", age=0)
        cancel_rx = _message(conn, tenant, e, key="rx-1", age=1)            # waits behind it
        spent = _message(conn, tenant, e, status="failed", attempts=5,
                         due_in=timedelta(seconds=-1))                          # 5 of 5 used
        stale = _message(conn, tenant, e, status="sending", claimed=timedelta(minutes=16))
        fresh = _message(conn, tenant, e, status="sending", claimed=timedelta(minutes=5))
        after_stale = _message(conn, tenant, e, key="rx-2", status="sending", age=2,
                               claimed=timedelta(minutes=16))
        conn.execute(text("SET LOCAL ROLE shri_integration"))
        got = _claim(conn)
        assert stale in got and after_stale in got
        assert not {dead_new_rx, cancel_rx, spent, fresh} & got.keys()
        conn.execute(text("RESET ROLE"))
        claimed_at = conn.execute(text("SELECT claimed_at > now() - interval '1 minute' FROM "
                                       "admin.integration_message WHERE id = :i"),
                                  {"i": stale}).scalar_one()
        assert claimed_at                                          # a new lease starts
        conn.rollback()


def test_a_message_whose_worker_never_reports_back_becomes_a_dead_letter(
        admin_engine: Engine) -> None:
    """Thulasi's last review of #52: the claim counts each attempt, so a message whose worker
    crashes every time is claimed at most max_attempts times; then it becomes a dead letter,
    holds its ordering key and stops being retried. One transaction, rolled back."""
    with admin_engine.connect() as conn:
        tenant = uuid.uuid4()
        conn.execute(text("INSERT INTO admin.tenant (id, slug, name) VALUES "
                          "(:i, :s, 'Test practice')"), {"i": tenant, "s": f"t-{tenant.hex[:12]}"})
        e = _endpoint(conn, tenant)
        new_rx = _message(conn, tenant, e, key="rx-1", age=0)
        cancel_rx = _message(conn, tenant, e, key="rx-1", age=1)
        expire = text("UPDATE admin.integration_message SET claimed_at = now() - "
                      "interval '16 minutes' WHERE id = :i")     # the worker died, again
        row = text("SELECT status, attempts, last_error FROM admin.integration_message "
                   "WHERE id = :i")
        for attempt in range(1, 6):                              # max_attempts is 5
            conn.execute(text("SET LOCAL ROLE shri_integration"))
            got = _claim(conn)
            conn.execute(text("RESET ROLE"))
            assert new_rx in got and cancel_rx not in got
            assert conn.execute(row, {"i": new_rx}).one()[:2] == ("sending", attempt)
            conn.execute(expire, {"i": new_rx})
        conn.execute(text("SET LOCAL ROLE shri_integration"))
        got = _claim(conn)
        conn.execute(text("RESET ROLE"))
        assert new_rx not in got and cancel_rx not in got         # the key stays held
        assert conn.execute(row, {"i": new_rx}).one() == (
            "dead-letter", 5, "no outcome reported after the last attempt")
        conn.rollback()


def test_outbox_payload_is_a_small_object(admin_engine: Engine) -> None:
    with admin_engine.connect() as conn:
        tenant = make_tenant(admin_engine)
        e = _endpoint(conn, tenant)
        mid = _message(conn, tenant, e)
        update = "UPDATE admin.integration_message SET payload = CAST(:p AS jsonb) WHERE id = :i"
        assert sqlstate(conn, update, {"p": '{"orderId": "x"}', "i": mid}) is None
        assert sqlstate(conn, update, {"p": '["x"]', "i": mid}) == CHECK_FAILED
        assert sqlstate(conn, update, {"p": '{"note": "' + "x" * 9000 + '"}', "i": mid}) \
            == CHECK_FAILED
        conn.rollback()


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
        body = ("UPDATE admin.idempotency_record SET response_body_enc = :b "
                "WHERE tenant_id = :t AND key = 'k-body'")
        conn.execute(text(insert), {**good, "k": "k-body"})
        assert sqlstate(conn, body, {"b": "vault:v2:e30=", "t": tenant}) is None
        assert sqlstate(conn, body, {"b": '{"patient": "x"}', "t": tenant}) == CHECK_FAILED
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
        assert sqlstate(conn, insert, {**good, "u": None}) == "23502"          # NOT NULL
        assert sqlstate(conn, insert, {**good, "done": finished}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "succeeded"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "failed", "done": finished}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "failed", "done": finished,
                                       "e": '{"type": "about:blank"}'}) is None
        assert sqlstate(conn, insert, {**good, "rt": "Binary"}) == CHECK_FAILED
        assert sqlstate(conn, insert, {**good, "s": "running"}) is None
        conn.rollback()


def test_events_are_written_once_and_never_deleted_by_a_role(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(text("INSERT INTO admin.event_log (id, tenant_id, type, subject, data) "
                          "VALUES (gen_random_uuid(), :t, 'appointment.updated', "
                          "'appointment/x', '{}')"), {"t": tenant})
        assert sqlstate(conn, "UPDATE admin.event_log SET type = 'x' WHERE tenant_id = :t",
                        {"t": tenant}) == DENIED
        for table in ("event_log", "app_session", "idempotency_record", "operation"):
            assert sqlstate(conn, f"DELETE FROM admin.{table} WHERE tenant_id = :t",  # noqa: S608
                            {"t": tenant}) == DENIED, table
        conn.rollback()


def test_operation_kind_and_creator(admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    """The contract's OperationKind allows 64 characters (D1). The creator is required and kept:
    an app_user with operations cannot be deleted (Vimal 5). One transaction, rolled back."""
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    insert = ("INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, status) "
              "VALUES (gen_random_uuid(), :t, :u, :k, 'queued')")
    with role_engine["shri_app"].connect() as conn:
        with_clinic(conn, tenant)
        assert sqlstate(conn, insert, {"t": tenant, "u": user, "k": "k" * 64}) is None
        assert sqlstate(conn, insert, {"t": tenant, "u": user, "k": "k" * 65}) == "22001"
        conn.execute(text(insert), {"t": tenant, "u": user, "k": "export"})
        conn.commit()
    with admin_engine.connect() as c:
        assert sqlstate(c, "DELETE FROM admin.app_user WHERE id = :u", {"u": user}) == "23001"
        c.rollback()


# =========================================================================== retention purge
def test_purge_removes_only_rows_past_retention_in_every_clinic(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    t1, t2 = make_tenant(admin_engine), make_tenant(admin_engine)
    u1, u2 = make_user(admin_engine, t1), make_user(admin_engine, t2)
    hours = timedelta(hours=1)
    with admin_engine.begin() as c:
        live, ended, logged_out, recent, idled_out = (token_hash() for _ in range(5))
        _insert_session(c, t1, u1, live)
        # Idled out 25 hours ago; its absolute expiry was only 13 hours ago (Vimal, #52).
        _insert_session(c, t1, u1, idled_out, expires=-13 * hours, idle=-25 * hours)
        _insert_session(c, t2, u2, ended, expires=-25 * hours)        # ended 25 hours ago
        _insert_session(c, t1, u1, recent, expires=-23 * hours)       # within the 24 hours
        _insert_session(c, t1, u1, logged_out, revoked=True)          # logged out just now
        c.execute(text("UPDATE admin.app_session SET revoked_at = now() - interval '25 hours' "
                       "WHERE token_hash = :h"), {"h": logged_out})
        for tenant, user, expires in ((t1, u1, "now() - interval '1 minute'"),
                                      (t2, u2, "now() + interval '1 hour'")):
            c.execute(text("INSERT INTO admin.idempotency_record (id, tenant_id, user_id, method, "
                           "path, key, request_hash, state, expires_at) VALUES "
                           f"(gen_random_uuid(), :t, :u, 'POST', '/x', :k, :h, 'in-progress', "
                           f"{expires})"), {"t": tenant, "u": user, "k": str(uuid.uuid4()),
                                             "h": token_hash()})
        for tenant, age in ((t1, "11 minutes"), (t2, "9 minutes")):
            c.execute(text("INSERT INTO admin.event_log (id, tenant_id, type, subject, created_at) "
                           f"VALUES (gen_random_uuid(), :t, 'x.y', 's', now() - interval '{age}')"),
                      {"t": tenant})
        for tenant, user, done in ((t2, u2, "now() - interval '8 days'"),
                                   (t1, u1, "now() - interval '6 days'")):
            c.execute(text("INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, "
                           "status, completed_at) VALUES (gen_random_uuid(), :t, :u, 'export', "
                           f"'succeeded', {done})"), {"t": tenant, "u": user})
        c.execute(text("INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, "
                       "status) VALUES (gen_random_uuid(), :t, :u, 'export', 'running')"),
                  {"t": t1, "u": u1})
    count = ("SELECT (SELECT count(*) FROM admin.app_session WHERE tenant_id IN (:a, :b)), "
             "(SELECT count(*) FROM admin.idempotency_record WHERE tenant_id IN (:a, :b)), "
             "(SELECT count(*) FROM admin.event_log WHERE tenant_id IN (:a, :b)), "
             "(SELECT count(*) FROM admin.operation WHERE tenant_id IN (:a, :b))")
    with admin_engine.connect() as c:
        assert tuple(c.execute(text(count), {"a": t1, "b": t2}).one()) == (5, 2, 2, 3)
    with role_engine["shri_maintenance"].connect() as conn:            # no clinic set
        deleted: dict[str, int] = {row.table_name: row.deleted for row in conn.execute(text(
            "SELECT table_name, deleted FROM admin.purge_expired_runtime_rows()"))}
        conn.commit()
    # At least ours (other tests' expired rows may go too); only counts come back.
    assert set(deleted) == {"app_session", "idempotency_record", "event_log", "operation"}
    assert deleted["app_session"] >= 3 and deleted["idempotency_record"] >= 1
    assert deleted["event_log"] >= 1 and deleted["operation"] >= 1
    with admin_engine.connect() as c:
        assert tuple(c.execute(text(count), {"a": t1, "b": t2}).one()) == (2, 1, 1, 2)
        kept = set(c.execute(text("SELECT token_hash FROM admin.app_session WHERE tenant_id IN "
                                  "(:a, :b)"), {"a": t1, "b": t2}).scalars())
    assert kept == {live, recent}


# ============================================================== the partner worker (B5)
def test_partner_worker_completes_only_the_operations_assigned_to_it(
        admin_engine: Engine, role_engine: dict[str, Engine]) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    mine, theirs = uuid.uuid4(), uuid.uuid4()
    with admin_engine.begin() as c:
        for oid, assigned in ((mine, True), (theirs, False)):
            c.execute(text("INSERT INTO admin.operation (id, tenant_id, created_by_user_id, kind, "
                           "status, assigned_to_integration) VALUES (:i, :t, :u, 'eligibility', "
                           "'running', :a)"), {"i": oid, "t": tenant, "u": user, "a": assigned})
    finish = ("UPDATE admin.operation SET status = 'succeeded', completed_at = now(), "
              "updated_at = now() WHERE id = :i")
    with role_engine["shri_integration"].connect() as conn:
        with_clinic(conn, tenant)
        assert conn.execute(text(finish), {"i": mine}).rowcount == 1
        assert conn.execute(text(finish), {"i": theirs}).rowcount == 0     # not its operation
        for column in ("assigned_to_integration = false", "kind = 'x'",
                       "created_by_user_id = NULL"):
            assert sqlstate(conn, f"UPDATE admin.operation SET {column} WHERE id = :i",  # noqa: S608
                            {"i": mine}) == DENIED, column
        assert sqlstate(conn, "INSERT INTO admin.operation (id, tenant_id, created_by_user_id, "
                        "kind, status) VALUES (gen_random_uuid(), :t, :u, 'x', 'queued')",
                        {"t": tenant, "u": user}) == DENIED
        conn.rollback()


def test_partner_worker_publishes_events_in_its_clinic(admin_engine: Engine,
                                                       role_engine: dict[str, Engine]) -> None:
    tenant, other = make_tenant(admin_engine), make_tenant(admin_engine)
    insert = ("INSERT INTO admin.event_log (id, tenant_id, type, subject, patient_id, "
              "target_user_id, target_role_code) VALUES (gen_random_uuid(), :t, "
              "'result.received', 'result/x', NULL, NULL, :r)")
    with role_engine["shri_integration"].connect() as conn:
        with_clinic(conn, tenant)
        assert sqlstate(conn, insert, {"t": tenant, "r": "MD"}) is None  # no RETURNING
        assert sqlstate(conn, insert, {"t": other, "r": "MD"}) == DENIED
        # A code as core's ROLE_PERMISSIONS spells it, not a name or a UUID.
        for bad in ("md", "Physician", str(uuid.uuid4()), "M"):
            assert sqlstate(conn, insert, {"t": tenant, "r": bad}) == CHECK_FAILED, bad
        conn.rollback()


# ======================================================== audit: payload 2, partner, break-glass
def test_audit_hash_covers_the_category_from_now_on(admin_engine: Engine) -> None:
    """Thulasi's review of #52. A row written before 0005 keeps payload 1 and still verifies;
    every new row is payload 2, whatever the insert says, and a change to its category breaks
    the chain. One transaction, rolled back."""
    tenant = make_tenant(admin_engine)
    insert = ("INSERT INTO audit.audit_event (tenant_id, actor_type, action, category, outcome, "
              "hash_version) VALUES (:t, 'system', 'read', 'phi-read', 'success', :v)")
    verify = text("SELECT count(*) FROM shri_audit_verify(:t)")
    with admin_engine.connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(text(insert), {"t": tenant, "v": 2})
        # Make that first row what a pre-0005 row is: payload 1 (triggers off for this only).
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        conn.execute(text("UPDATE audit.audit_event SET hash_version = 1 WHERE tenant_id = :t"),
                     {"t": tenant})
        conn.execute(text("UPDATE audit.audit_event a SET hash = encode(digest("
                          "shri_audit_payload(a), 'sha256'), 'hex') WHERE tenant_id = :t"),
                     {"t": tenant})
        conn.execute(text("SET LOCAL session_replication_role = origin"))
        conn.execute(text(insert), {"t": tenant, "v": 1})            # asks for payload 1
        versions = conn.execute(text("SELECT hash_version FROM audit.audit_event WHERE "
                                     "tenant_id = :t ORDER BY chain_seq"), {"t": tenant}).scalars()
        assert list(versions) == [1, 2]                               # ...and gets 2
        assert conn.execute(verify, {"t": tenant}).scalar_one() == 0
        conn.execute(text("SET LOCAL session_replication_role = replica"))
        conn.execute(text("UPDATE audit.audit_event SET category = 'admin' WHERE tenant_id = :t "
                          "AND hash_version = 2"), {"t": tenant})
        problems = conn.execute(text("SELECT problem FROM shri_audit_verify(:t)"),
                                {"t": tenant}).scalars().all()
        assert problems == ["hash mismatch: event content was altered"]
        conn.rollback()


def test_partner_callbacks_have_their_own_actor(admin_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    with admin_engine.connect() as conn:
        with_clinic(conn, tenant)
        assert sqlstate(conn, "INSERT INTO audit.audit_event (tenant_id, actor_type, action, "
                        "category, outcome) VALUES (:t, 'partner', 'create', 'phi-write', "
                        "'success')", {"t": tenant}) is None
        conn.rollback()


@pytest.mark.parametrize(("reason", "refused"), [
    ("emergency-care", None),                       # a code-only grant: its code is the reason
    ("other: covering for a colleague", None),
    (None, CHECK_FAILED),
    ("", CHECK_FAILED),                             # empty or blank is no reason (Vimal, #52)
    ("   ", CHECK_FAILED),
])
def test_break_glass_audit_row_carries_the_grants_reason(admin_engine: Engine,
                                                         reason: str | None,
                                                         refused: str | None) -> None:
    """D5: core copies the grant's reason (the code, plus the text when given) into the audit
    row in the same transaction; the database refuses a break-glass audit row with none."""
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    with admin_engine.connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(text("SET LOCAL ROLE shri_app"))
        assert sqlstate(conn, "INSERT INTO audit.audit_event (tenant_id, actor_type, "
                        "actor_user_id, action, category, outcome, reason) VALUES (:t, 'user', "
                        ":u, 'break-glass', 'security', 'success', :r)",
                        {"t": tenant, "u": user, "r": reason}) == refused
        conn.rollback()


def test_the_maintenance_role_can_only_run_the_purge(admin_engine: Engine) -> None:
    """D23 as amended in #64: shri_maintenance runs the retention purge and nothing else. It has
    no table privileges anywhere, and only USAGE on admin, to call the function."""
    with admin_engine.connect() as c:
        tables = c.execute(text(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
            "WHERE schemaname IN ('clinical', 'admin', 'audit', 'public')")).scalars().all()
        for table in tables:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                assert not c.execute(text("SELECT has_table_privilege('shri_maintenance', :t, :p)"),
                                     {"t": table, "p": privilege}).scalar_one(), (table, privilege)
        # The data schemas; public's USAGE is whatever PUBLIC has (the image revokes it).
        usage = {s: c.execute(text("SELECT has_schema_privilege('shri_maintenance', :s, 'USAGE')"),
                              {"s": s}).scalar_one() for s in ("clinical", "admin", "audit")}
        assert usage == {"clinical": False, "admin": True, "audit": False}
        for function in ("admin.lookup_session(text)", "admin.claim_outbound_messages(integer)"):
            assert not c.execute(text("SELECT has_function_privilege('shri_maintenance', :f, "
                                      "'EXECUTE')"), {"f": function}).scalar_one(), function
