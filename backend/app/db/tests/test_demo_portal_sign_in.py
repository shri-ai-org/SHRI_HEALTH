"""Migration 0027: the demo server's portal sign-in by mobile number and date of birth (Vimal on
#85, 18 Nov). admin.demo_portal_patient() is called as shri_app with no clinic set, as core calls
it before a patient is known, and answers only in the demo seed's clinic; demo-phone accounts
and sessions are written as shri_app in their clinic, with the tables' triggers firing.
Synthetic data only: fictional numbers and dates."""
from __future__ import annotations

import datetime as dt
import secrets
import uuid

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import DBAPIError

from app.db.seed.starter import PRACTICES
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_core_runtime import token_hash, with_clinic
from app.db.tests.test_portal_sign_in import _patient, app_conn_engine

__all__ = ["app_conn_engine"]                 # a fixture, used by name
LOOKUP = text("SELECT * FROM admin.demo_portal_patient(:digits, :dob)")
CIPHER = "vault:v1:c2ltdWxhdGVk"
DOB = dt.date(1937, 5, 21)                    # no other test patient's date of birth
DEMO = PRACTICES[0]                           # the demo seed's clinic, Riverbend
CLINIC_A = DEMO.tenant_id


def _demo_clinic(admin_engine: Engine) -> uuid.UUID:
    """The demo seed's clinic, the only one the lookup answers for, as the seed makes it (the
    seed never changes an existing tenant, so this must match it)."""
    with admin_engine.begin() as c:
        c.execute(text("INSERT INTO admin.tenant (id, slug, name, timezone) VALUES (:i, :s, :n, "
                       ":z) ON CONFLICT DO NOTHING"),
                  {"i": CLINIC_A, "s": DEMO.slug, "n": DEMO.name, "z": DEMO.timezone})
    return CLINIC_A


def _number() -> tuple[str, str]:
    """A fictional 10-digit U.S. number (555-0100 to 555-0199), as stored and as core sends
    it: a random area code keeps tests apart."""
    area, line = 200 + secrets.randbelow(799), secrets.randbelow(100)
    return f"({area}) 555-01{line:02d}", f"1{area}55501{line:02d}"


def _phoned(admin_engine: Engine, app_engine: Engine, tenant: uuid.UUID, stored: str,
            dob: dt.date = DOB) -> uuid.UUID:
    """A patient whose only number is ``stored`` (the builder's shared test number replaced)."""
    patient = _patient(app_engine, tenant)
    with admin_engine.begin() as c:            # the parent-touch trigger names bare tables
        c.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        c.execute(text("UPDATE clinical.contact_point SET value = :v WHERE patient_id = :p"),
                  {"v": stored, "p": patient})
        c.execute(text("UPDATE clinical.patient SET birth_date = :d WHERE id = :p"),
                  {"d": dob, "p": patient})
    return patient


def _lookup(engine: Engine, digits: str | None, dob: dt.date | None) -> list[tuple[uuid.UUID,
                                                                                   uuid.UUID]]:
    with engine.connect() as c:                           # no clinic set
        return [(r.tenant_id, r.patient_id)
                for r in c.execute(LOOKUP, {"digits": digits, "dob": dob})]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_one_chart_with_the_number_and_date_of_birth_is_found(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine) -> None:
    clinic = _demo_clinic(admin_engine)
    stored, digits = _number()
    patient = _phoned(admin_engine, app_engine, clinic, stored)
    assert _lookup(app_conn_engine, digits, DOB) == [(clinic, patient)]
    stored_2, digits_2 = _number()                   # 11 digits, stored with its +1
    other = _phoned(admin_engine, app_engine, clinic, "+1 " + stored_2)
    assert _lookup(app_conn_engine, digits_2, DOB) == [(clinic, other)]
    for wrong in ((digits, DOB + dt.timedelta(days=1)), (digits[1:], DOB), ("+" + digits, DOB),
                  ("0" + digits[1:], DOB), ("", DOB), (None, DOB), (digits, None),
                  ("19995550000", DOB)):
        assert _lookup(app_conn_engine, *wrong) == []


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_outside_the_demo_seeds_clinic_nobody_is_ever_found(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine) -> None:
    """The production-like case: a clinic that isn't the demo seed's, as every clinic of a
    database the seed never ran on. Its chart is never found, and never makes the demo clinic's
    chart with the same number ambiguous."""
    stored, digits = _number()
    elsewhere = make_tenant(admin_engine)
    _phoned(admin_engine, app_engine, elsewhere, stored)
    assert _lookup(app_conn_engine, digits, DOB) == []
    clinic = _demo_clinic(admin_engine)
    patient = _phoned(admin_engine, app_engine, clinic, stored)
    assert _lookup(app_conn_engine, digits, DOB) == [(clinic, patient)]
    with admin_engine.connect() as c:                    # the migration names the seed's clinic
        body = c.execute(text("SELECT pg_get_functiondef("
                              "'admin.demo_portal_patient'::regproc)")).scalar_one()
    assert f"'{CLINIC_A}'::uuid" in body


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_two_charts_with_the_number_and_date_of_birth_open_nothing(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine) -> None:
    first = second = _demo_clinic(admin_engine)
    stored, digits = _number()
    one = _phoned(admin_engine, app_engine, first, stored)
    two = _phoned(admin_engine, app_engine, second, stored)
    assert _lookup(app_conn_engine, digits, DOB) == []
    with admin_engine.begin() as c:                      # still ambiguous with one restricted
        c.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :p"),
                  {"p": two})
    assert _lookup(app_conn_engine, digits, DOB) == []
    with admin_engine.begin() as c:                      # a parent and a child: dates differ
        c.execute(text("UPDATE clinical.patient SET birth_date = :d WHERE id = :p"),
                  {"d": dt.date(2001, 6, 14), "p": two})
    assert _lookup(app_conn_engine, digits, DOB) == [(first, one)]
    assert _lookup(app_conn_engine, digits, dt.date(2001, 6, 14)) == []     # restricted


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
@pytest.mark.parametrize("why", ["restricted", "very-restricted", "inactive", "disabled-account"])
def test_restricted_inactive_and_disabled_charts_are_never_found(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine, why: str) -> None:
    tenant = _demo_clinic(admin_engine)
    stored, digits = _number()
    patient = _phoned(admin_engine, app_engine, tenant, stored)
    with app_conn_engine.connect() as c:                 # a live account doesn't stop it
        with_clinic(c, tenant)
        account = _demo_account(c, tenant, patient)
        c.commit()
    assert _lookup(app_conn_engine, digits, DOB) == [(tenant, patient)]
    change = {"restricted": "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :p",
              "very-restricted": "UPDATE clinical.patient SET meta_security = ARRAY['V'] "
                                 "WHERE id = :p",
              "inactive": "UPDATE clinical.patient SET active = false WHERE id = :p",
              "disabled-account": "UPDATE admin.portal_account SET status = 'disabled', "
                                  "disabled_at = now(), disabled_reason = 'Misuse reported' "
                                  "WHERE id = :a"}[why]
    with admin_engine.begin() as c:
        c.execute(text(change), {"p": patient, "a": account})
    assert _lookup(app_conn_engine, digits, DOB) == []


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
@pytest.mark.parametrize("case", ["found", "unknown", "ambiguous", "restricted", "elsewhere"])
def test_the_lookup_clears_its_setting_before_every_return(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine, case: str) -> None:
    clinic = _demo_clinic(admin_engine)
    stored, digits = _number()
    if case != "unknown":
        patient = _phoned(admin_engine, app_engine,
                          make_tenant(admin_engine) if case == "elsewhere" else clinic, stored)
    if case == "ambiguous":
        _phoned(admin_engine, app_engine, clinic, stored)
    if case == "restricted":
        with admin_engine.begin() as c:
            c.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] "
                           "WHERE id = :p"), {"p": patient})
    with app_conn_engine.connect() as c:
        found = c.execute(LOOKUP, {"digits": digits, "dob": DOB}).all()
        assert len(found) == (1 if case == "found" else 0)
        # Same transaction: the function cleared its setting, so its policies are shut.
        assert c.execute(text("SELECT coalesce(current_setting('app.demo_portal_phone', true), "
                              "'')")).scalar_one() == ""


def _demo_account(c: Connection, tenant: uuid.UUID, patient: uuid.UUID) -> uuid.UUID:
    """A demo-phone account as core's demo sign-in creates it: active, enrolled now."""
    aid = uuid.uuid4()
    c.execute(text("INSERT INTO admin.portal_account (id, tenant_id, patient_id, status, "
                   "enrolled_at, sign_in_method) VALUES (:i, :t, :p, 'active', now(), "
                   "'demo-phone')"), {"i": aid, "t": tenant, "p": patient})
    return aid


SESSION = ("INSERT INTO admin.portal_session (id, tenant_id, account_id, patient_id, token_hash, "
           "sign_in_method, keycloak_access_token_enc, keycloak_refresh_token_enc, keycloak_sid, "
           "idle_expires_at, expires_at) VALUES (gen_random_uuid(), :t, :a, :p, :h, :m, :at, :rt, "
           ":sid, now() + interval '15 minutes', now() + interval '4 hours')")


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_demo_phone_account_and_session_have_no_keycloak_and_keep_their_method(
        app_conn_engine: Engine, admin_engine: Engine, app_engine: Engine) -> None:
    tenant = make_tenant(admin_engine)
    patient = _patient(app_engine, tenant)
    with app_conn_engine.connect() as c:
        with_clinic(c, tenant)
        account = _demo_account(c, tenant, patient)
        c.execute(text(SESSION), {"t": tenant, "a": account, "p": patient, "h": token_hash(),
                                  "m": "demo-phone", "at": None, "rt": None, "sid": None})
        c.commit()
    bad = [
        ({"m": "demo-phone", "at": CIPHER, "rt": CIPHER, "sid": None}, "tokens_match_method"),
        ({"m": "demo-phone", "at": None, "rt": None, "sid": "kc-sid"}, "tokens_match_method"),
        ({"m": "keycloak", "at": CIPHER, "rt": CIPHER, "sid": None},
         "fk_portal_session_account_sign_in_method"),
    ]
    for values, constraint in bad:
        with app_conn_engine.connect() as c:
            with_clinic(c, tenant)
            with pytest.raises(DBAPIError, match=constraint):
                c.execute(text(SESSION), {"t": tenant, "a": account, "p": patient,
                                          "h": token_hash(), **values})
    other = _patient(app_engine, tenant)
    for sql, constraint in (
            ("INSERT INTO admin.portal_account (id, tenant_id, patient_id, status, enrolled_at, "
             "sign_in_method, keycloak_user_id) VALUES (gen_random_uuid(), :t, :p, 'active', "
             "now(), 'demo-phone', 'kc-1')", "keycloak_has_user"),
            ("INSERT INTO admin.portal_account (id, tenant_id, patient_id) VALUES "
             "(gen_random_uuid(), :t, :p)", "keycloak_has_user"),
            ("INSERT INTO admin.portal_account (id, tenant_id, patient_id, sign_in_method"
             ") VALUES (gen_random_uuid(), :t, :p, 'sms')",
             "sign_in_method_codes")):
        with app_conn_engine.connect() as c:
            with_clinic(c, tenant)
            with pytest.raises(DBAPIError, match=constraint):
                c.execute(text(sql), {"t": tenant, "p": other})
    with app_conn_engine.connect() as c:                 # the method never changes
        with_clinic(c, tenant)
        with pytest.raises(DBAPIError, match="sign_in_method"):
            c.execute(text("UPDATE admin.portal_account SET sign_in_method = 'keycloak', "
                           "keycloak_user_id = 'kc-3' WHERE id = :a"), {"a": account})


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_only_shri_app_may_look_up(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        execute = {role: c.execute(text(
            "SELECT has_function_privilege(:r, 'admin.demo_portal_patient(text, date)', "
            "'EXECUTE')"), {"r": role}).scalar()
            for role in ("shri_app", "shri_portal", "shri_public", "shri_fhir_reader",
                         "shri_integration", "shri_maintenance")}
        assert execute == {"shri_app": True, "shri_portal": False, "shri_public": False,
                           "shri_fhir_reader": False, "shri_integration": False,
                           "shri_maintenance": False}
        assert c.execute(text(
            "SELECT p.prosecdef AND 'search_path=pg_catalog, pg_temp' = ANY (p.proconfig) "
            "AND pg_get_userbyid(p.proowner) = 'shri_migrator' FROM pg_proc p WHERE p.oid = "
            "'admin.demo_portal_patient'::regproc")).scalar()
