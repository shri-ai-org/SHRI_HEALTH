"""Migration 0009: online pre-registration (D96, A51; Thulasi's answers on #13).

The public form runs as shri_public and the front desk as shri_app, both by SET ROLE from the
superuser URL (see conftest.py), with forced row-level security in force. Synthetic data only.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    SKIP_WITHOUT_DATABASE,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.db.tests.test_core_runtime import make_user, with_clinic
from app.db.tests.test_db_rules import fails

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
SUBMIT = "admin.submit_pre_registration(text, uuid, text, jsonb, boolean, inet, text, text)"
CALL = text("SELECT admin.submit_pre_registration(:code, :key, :hash, CAST(:details AS jsonb), "
            ":consent, CAST(:ip AS inet), :ua, :cid)")
DETAILS: dict[str, Any] = {
    "name": {"given": ["Kaia401"], "family": "Lindgren118"}, "birthDate": "1990-03-14",
    "phones": [{"number": "+12175550142", "use": "mobile"}],
    "insurance": {"payerName": "Example Health Plan", "memberId": "TEST-MEMBER-042"},
}


@pytest.fixture(scope="module")
def public_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_public", require_search_path=False)
    yield engine
    engine.dispose()


def _practice(admin_engine: Engine, *, enabled: bool = True,
              active: bool = True) -> tuple[uuid.UUID, str]:
    tenant, code = make_tenant(admin_engine), secrets.token_urlsafe(16)
    with admin_engine.begin() as c:
        c.execute(text("UPDATE admin.tenant SET pre_registration_code = :c, "
                       "pre_registration_enabled = :e, is_active = :a WHERE id = :t"),
                  {"c": code, "e": enabled, "a": active, "t": tenant})
    return tenant, code


def _args(code: str, details: dict[str, Any] | None = None,
          key: uuid.UUID | None = None) -> dict[str, Any]:
    body = json.dumps(details or DETAILS)
    return {"code": code, "key": key or uuid.uuid4(), "details": body, "consent": True,
            "hash": hashlib.sha256(body.encode()).hexdigest(), "ip": "203.0.113.7",
            "ua": "Mozilla/5.0 (test)", "cid": f"req-{uuid.uuid4().hex[:12]}"}


def _submit(engine: Engine, args: dict[str, Any]) -> None:
    with engine.connect() as conn:
        conn.execute(CALL, args)
        conn.commit()


def _refused(engine: Engine, args: dict[str, Any]) -> tuple[str, str | None]:
    """The SQLSTATE and constraint a submission fails with."""
    with engine.connect() as conn:
        with pytest.raises(DBAPIError) as err:
            conn.execute(CALL, args)
        conn.rollback()
    orig: Any = err.value.orig
    return orig.sqlstate, orig.diag.constraint_name


def _requests(admin_engine: Engine, tenant: uuid.UUID) -> list[Any]:
    with admin_engine.connect() as c:
        return list(c.execute(text("SELECT * FROM admin.pre_registration WHERE tenant_id = :t "
                                   "ORDER BY created_at"), {"t": tenant}))


def _audit(admin_engine: Engine, tenant: uuid.UUID) -> list[Any]:
    with admin_engine.connect() as c:
        return list(c.execute(text("SELECT * FROM audit.audit_event WHERE tenant_id = :t "
                                   "ORDER BY chain_seq"), {"t": tenant}))


# ====================================================================== the public role's reach
def test_the_public_role_can_only_submit(admin_engine: Engine) -> None:
    """Thulasi on #13: EXECUTE on the insert function and nothing else; no table privileges."""
    with admin_engine.connect() as c:
        tables = c.execute(text(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
            "WHERE schemaname IN ('clinical', 'admin', 'audit', 'public')")).scalars().all()
        for table in tables:
            for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"):
                assert not c.execute(text("SELECT has_table_privilege('shri_public', :t, :p)"),
                                     {"t": table, "p": privilege}).scalar_one(), (table, privilege)
        usage = {s: c.execute(text("SELECT has_schema_privilege('shri_public', :s, 'USAGE')"),
                              {"s": s}).scalar_one() for s in ("clinical", "admin", "audit")}
        assert usage == {"clinical": False, "admin": True, "audit": False}
        callable_ = c.execute(text(
            "SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n "
            "ON n.oid = p.pronamespace WHERE n.nspname IN ('clinical', 'admin', 'audit') "
            "AND p.prosecdef AND has_function_privilege('shri_public', p.oid, 'EXECUTE')")
        ).scalars().all()
        assert callable_ == [SUBMIT.replace(", ", ",")]


# =========================================================================== the form's insert
def test_a_request_lands_in_its_practices_queue_with_its_audit_row(
        admin_engine: Engine, public_engine: Engine) -> None:
    tenant, code = _practice(admin_engine)
    args = _args(code)
    _submit(public_engine, args)
    [req] = _requests(admin_engine, tenant)
    assert (req.status, req.entry_source, req.idempotency_key) == (
        "pending", "patient-reported", args["key"])
    assert req.details == DETAILS and req.patient_id is None
    [event] = _audit(admin_engine, tenant)
    assert (event.actor_type, event.actor_user_id, event.action, event.category,
            event.outcome) == ("anonymous", None, "create", "phi-write", "success")
    assert (event.entity_type, event.entity_id, event.patient_id) == (
        "PreRegistration", str(req.id), None)
    assert (str(event.source_ip), event.correlation_id) == ("203.0.113.7", args["cid"])
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM public.shri_audit_verify(:t)"),
                         {"t": tenant}).scalar_one() == 0


def test_the_callers_clinic_setting_is_left_as_it_was(admin_engine: Engine,
                                                      public_engine: Engine) -> None:
    _, code = _practice(admin_engine)
    with public_engine.connect() as conn:
        conn.execute(CALL, _args(code))
        assert conn.execute(text("SELECT coalesce(current_setting('app.current_tenant_id', "
                                 "true), '')")).scalar_one() == ""
        mine = str(uuid.uuid4())
        with_clinic(conn, uuid.UUID(mine))
        conn.execute(CALL, _args(code))
        assert conn.execute(text("SELECT current_setting('app.current_tenant_id', true)")
                            ).scalar_one() == mine
        conn.rollback()


@pytest.mark.parametrize("practice", ["unknown", "turned-off", "inactive"])
def test_a_code_that_takes_no_requests_is_not_found(admin_engine: Engine, public_engine: Engine,
                                                    practice: str) -> None:
    tenant, code = _practice(admin_engine, enabled=practice != "turned-off",
                             active=practice != "inactive")
    if practice == "unknown":
        code = secrets.token_urlsafe(16)
    assert _refused(public_engine, _args(code)) == ("P0002", None)
    assert not _requests(admin_engine, tenant) and not _audit(admin_engine, tenant)


def test_a_replay_changes_nothing_and_a_reused_key_is_refused(admin_engine: Engine,
                                                              public_engine: Engine) -> None:
    tenant, code = _practice(admin_engine)
    other, other_code = _practice(admin_engine)
    args = _args(code)
    _submit(public_engine, args)
    _submit(public_engine, {**args, "cid": "req-retry"})                 # a retry
    changed = _args(code, {**DETAILS, "birthDate": "1990-03-15"}, key=args["key"])
    assert _refused(public_engine, changed) == ("P0001", "idempotency_key_reused")
    assert len(_requests(admin_engine, tenant)) == 1 and len(_audit(admin_engine, tenant)) == 1
    _submit(public_engine, {**args, "code": other_code})               # unique per clinic only
    assert len(_requests(admin_engine, other)) == 1


@pytest.mark.parametrize(("details", "why"), [
    ({k: v for k, v in DETAILS.items() if k != "birthDate"}, "no date of birth"),
    ({k: v for k, v in DETAILS.items() if k != "phones"}, "neither a phone nor an email"),
    ({**DETAILS, "reasonForVisit": "x" * 40000}, "too large"),
])
def test_the_form_needs_its_required_fields(admin_engine: Engine, public_engine: Engine,
                                            details: dict[str, Any], why: str) -> None:
    tenant, code = _practice(admin_engine)
    assert _refused(public_engine, _args(code, details))[0] == "23514", why
    assert not _requests(admin_engine, tenant) and not _audit(admin_engine, tenant)


def test_an_email_alone_is_enough(admin_engine: Engine, public_engine: Engine) -> None:
    tenant, code = _practice(admin_engine)
    details = {k: v for k, v in DETAILS.items() if k != "phones"} | {"email": "k@example.com"}
    _submit(public_engine, _args(code, details))
    assert len(_requests(admin_engine, tenant)) == 1


# ======================================================================= the front desk's queue
def _queued(admin_engine: Engine, public_engine: Engine) -> tuple[uuid.UUID, uuid.UUID]:
    tenant, code = _practice(admin_engine)
    _submit(public_engine, _args(code))
    return tenant, _requests(admin_engine, tenant)[0].id


def _decide(s: Session, rid: uuid.UUID, **values: Any) -> None:
    sets = ", ".join(f"{k} = :{k}" for k in values)
    s.execute(text(f"UPDATE admin.pre_registration SET {sets} WHERE id = :rid"),
              {"rid": rid, **values})
    s.flush()


def test_the_front_desk_reads_and_decides_but_never_adds_or_deletes(
        admin_engine: Engine, app_engine: Engine, public_engine: Engine) -> None:
    tenant, rid = _queued(admin_engine, public_engine)
    s = open_session(app_engine, tenant)
    try:
        assert s.execute(text("SELECT count(*) FROM admin.pre_registration")).scalar_one() == 1
        for sql in ("DELETE FROM admin.pre_registration",
                    "UPDATE admin.pre_registration SET details = '{}'::jsonb",
                    "INSERT INTO admin.pre_registration (id, tenant_id, idempotency_key, "
                    "request_hash, details, contact_consent) SELECT gen_random_uuid(), "
                    "tenant_id, gen_random_uuid(), request_hash, details, true "
                    "FROM admin.pre_registration"):
            with fails(s, "42501"):
                s.execute(text(sql))
        with fails(s, "42501"):
            s.execute(text(f"SELECT {SUBMIT.split('(')[0]}('x', gen_random_uuid(), 'x', "
                           "'{}'::jsonb, true, NULL, NULL, NULL)"))
        user = make_user(admin_engine, tenant)
        patient = b.patient(s)
        s.execute(text("UPDATE admin.pre_registration SET status = 'accepted', decided_at = now(), "
                       "decided_by_user_id = :u, patient_id = :p, id_document_type = "
                       "'drivers-license' WHERE id = :r"), {"u": user, "p": patient.id, "r": rid})
        s.commit()
        with fails(s, "P0001", message="no longer changes"):
            _decide(s, rid, id_document_type="passport")
    finally:
        s.rollback()
        s.close()


def test_a_decision_must_be_complete(admin_engine: Engine, app_engine: Engine,
                                     public_engine: Engine) -> None:
    tenant, rid = _queued(admin_engine, public_engine)
    user = make_user(admin_engine, tenant)
    s = open_session(app_engine, tenant)
    try:
        decided = "status = '{}', decided_at = now(), decided_by_user_id = :u"
        # Accepted without a patient or an ID check, then without a patient.
        for extra in ("", ", id_document_type = 'passport'"):
            with fails(s, "23514", "ck_pre_registration_decision_matches_status"):
                s.execute(text("UPDATE admin.pre_registration SET " + decided.format("accepted")
                               + extra + " WHERE id = :r"), {"u": user, "r": rid})
        with fails(s, "23514", "ck_pre_registration_decision_matches_status"):
            s.execute(text("UPDATE admin.pre_registration SET " + decided.format("rejected")
                           + " WHERE id = :r"), {"u": user, "r": rid})     # no reason
        for blank in ("' '", "NULL"):
            with fails(s, "23514", "ck_pre_registration_other_reason_has_text"):
                s.execute(text("UPDATE admin.pre_registration SET " + decided.format("rejected")
                               + ", rejection_reason_code = 'other', rejection_reason_text = "
                               + blank + " WHERE id = :r"), {"u": user, "r": rid})
        s.execute(text("UPDATE admin.pre_registration SET " + decided.format("rejected")
                       + ", rejection_reason_code = 'spam' WHERE id = :r"), {"u": user, "r": rid})
        s.commit()
    finally:
        s.rollback()
        s.close()


def test_a_request_links_only_a_patient_of_its_own_clinic(
        admin_engine: Engine, app_engine: Engine, public_engine: Engine) -> None:
    tenant, rid = _queued(admin_engine, public_engine)
    elsewhere = open_session(app_engine, make_tenant(admin_engine))
    theirs = b.patient(elsewhere).id
    elsewhere.commit()
    elsewhere.close()
    user = make_user(admin_engine, tenant)
    s = open_session(app_engine, tenant)
    try:
        with fails(s, "23503"):
            s.execute(text("UPDATE admin.pre_registration SET status = 'accepted', decided_at = "
                           "now(), decided_by_user_id = :u, patient_id = :p, id_document_type = "
                           "'passport' WHERE id = :r"), {"u": user, "p": theirs, "r": rid})
    finally:
        s.rollback()
        s.close()


def test_another_clinic_sees_nothing(admin_engine: Engine, app_engine: Engine,
                                     public_engine: Engine) -> None:
    _queued(admin_engine, public_engine)
    s = open_session(app_engine, make_tenant(admin_engine))
    try:
        assert s.execute(text("SELECT count(*) FROM admin.pre_registration")).scalar_one() == 0
    finally:
        s.close()


# ====================================================================== the 30-day retention
def test_the_purge_removes_only_requests_rejected_or_unreviewed_for_30_days(
        admin_engine: Engine, app_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    s = open_session(app_engine, tenant)
    patient = b.patient(s).id
    s.commit()
    s.close()
    rows = {   # name: (status, days since arrival, days since the decision)
        "old pending": ("pending", 31, None), "new pending": ("pending", 29, None),
        "old rejection": ("rejected", 40, 31), "new rejection": ("rejected", 40, 29),
        "old acceptance": ("accepted", 400, 399),
    }
    ids = {}
    with admin_engine.begin() as c:                                # the superuser, for old rows
        for name, (status, arrived, decided) in rows.items():
            ids[name] = uuid.uuid4()
            c.execute(text(
                "INSERT INTO admin.pre_registration (id, tenant_id, idempotency_key, request_hash, "
                "details, contact_consent, status, created_at, decided_at, decided_by_user_id, "
                "patient_id, id_document_type, rejection_reason_code) VALUES (:i, :t, "
                "gen_random_uuid(), :h, CAST(:d AS jsonb), true, :s, now() - make_interval("
                "days => :a), now() - make_interval(days => :dd), :u, :p, :doc, :why)"),
                {"i": ids[name], "t": tenant, "h": "0" * 64, "d": json.dumps(DETAILS), "s": status,
                 "a": arrived, "dd": decided, "u": user if decided else None,
                 "p": patient if status == "accepted" else None,
                 "doc": "passport" if status == "accepted" else None,
                 "why": "spam" if status == "rejected" else None})
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_maintenance", require_search_path=False)
    with engine.connect() as conn:                                   # no clinic set
        deleted: dict[str, int] = {r.table_name: r.deleted for r in conn.execute(text(
            "SELECT table_name, deleted FROM admin.purge_expired_runtime_rows()"))}
        conn.commit()
    engine.dispose()
    assert deleted["pre_registration"] >= 2
    kept = {r.id for r in _requests(admin_engine, tenant)}
    assert kept == {ids["new pending"], ids["new rejection"], ids["old acceptance"]}


# ============================================================================ existing tables
def test_an_anonymous_audit_row_never_names_a_user(admin_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    user = make_user(admin_engine, tenant)
    with admin_engine.connect() as c:
        with pytest.raises(DBAPIError) as err:
            c.execute(text("INSERT INTO audit.audit_event (tenant_id, actor_type, actor_user_id, "
                           "action, category, outcome) VALUES (:t, 'anonymous', :u, 'create', "
                           "'phi-write', 'success')"), {"t": tenant, "u": user})
        c.rollback()
    assert err.value.orig.diag.constraint_name == "ck_audit_event_anonymous_actor"  # type: ignore[union-attr]


@pytest.mark.parametrize(("code", "enabled", "constraint"), [
    ("too-short", False, "ck_tenant_pre_registration_code_format"),
    ("has spaces in the code!", False, "ck_tenant_pre_registration_code_format"),
    (None, True, "ck_tenant_pre_registration_needs_code"),
])
def test_a_practice_link_needs_a_well_formed_code(admin_engine: Engine, code: str | None,
                                                  enabled: bool, constraint: str) -> None:
    tenant = make_tenant(admin_engine)
    with admin_engine.connect() as c:
        with pytest.raises(DBAPIError) as err:
            c.execute(text("UPDATE admin.tenant SET pre_registration_code = :c, "
                           "pre_registration_enabled = :e WHERE id = :t"),
                      {"c": code, "e": enabled, "t": tenant})
        c.rollback()
    assert err.value.orig.diag.constraint_name == constraint  # type: ignore[union-attr]


def test_the_practice_turns_its_own_link_off(admin_engine: Engine, app_engine: Engine,
                                             public_engine: Engine) -> None:
    tenant, code = _practice(admin_engine)
    with app_engine.connect() as conn:
        with_clinic(conn, tenant)
        conn.execute(text("UPDATE admin.tenant SET pre_registration_enabled = false"))
        conn.commit()
    assert _refused(public_engine, _args(code)) == ("P0002", None)


@pytest.mark.parametrize("prefix", ["A", "ABCDEFGHI"])
def test_an_mrn_prefix_is_2_to_8_characters(db: Session, prefix: str) -> None:
    with fails(db, "23514", "ck_mrn_counter_prefix_format"):
        db.add(M["mrn_counter"](prefix=prefix, system="urn:oid:1.2.3"))
        db.flush()
