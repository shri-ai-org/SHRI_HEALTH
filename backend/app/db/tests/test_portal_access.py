"""Migration 0011, part 2: what the patient portal's role reads and writes (D93, D86, D90,
D91). The portal runs as shri_portal by SET ROLE from the superuser URL (see conftest.py), with
the clinic and the session patient set, as core's portal_db sets them; staff data is written
as shri_app. Synthetic data only."""
from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, create_engine, text
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
from app.db.tests.test_db_rules import fails

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]

M = MAPPERS
DENIED = "42501"


@pytest.fixture(scope="module")
def portal_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_portal")
    yield engine
    engine.dispose()


@pytest.fixture
def chart(app_engine: Engine, admin_engine: Engine) -> Iterator[dict[str, Any]]:
    """A practice with two patients, each with a visit, a problem, a result and a note."""
    tenant = make_tenant(admin_engine)
    s = open_session(app_engine, tenant)
    ctx = b.practice(s)
    out: dict[str, Any] = {"tenant": tenant, "ctx": ctx, "s": s}
    for who, family in (("me", "Lindgren118"), ("other", "Okafor904")):
        pt = b.patient(s, family, "Test")
        enc = b.encounter(s, pt, ctx, status="finished")
        out[who] = {"pt": pt, "enc": enc, "problem": b.condition(s, pt, enc),
                    "result": b.blood_pressure(s, pt, enc), "note": b.note(s, pt, enc, ctx)}
    s.commit()
    yield out
    conn = s.bind
    s.close()
    conn.close()  # type: ignore[union-attr]


def _as_patient(conn: Connection, chart: dict[str, Any], who: str = "me") -> Connection:
    conn.execute(text("SELECT set_config('app.current_tenant_id', :t, true), "
                      "set_config('app.current_patient_id', :p, true)"),
                 {"t": str(chart["tenant"]), "p": str(chart[who]["pt"].id)})
    return conn


def _ids(conn: Connection, sql: str) -> set[uuid.UUID]:
    return {r[0] for r in conn.execute(text(sql))}


def _refused(conn: Connection, sql: str, params: dict[str, Any] | None = None) -> str:
    savepoint = conn.begin_nested()
    with pytest.raises(DBAPIError) as err:
        conn.execute(text(sql), params or {})
    savepoint.rollback()
    return str(getattr(err.value.orig, "sqlstate", ""))


# ================================================================== own chart only (D93)
def test_the_portal_sees_only_the_session_patients_chart(portal_engine: Engine,
                                                         chart: dict[str, Any]) -> None:
    me, other = chart["me"], chart["other"]
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert _ids(c, "SELECT id FROM clinical.patient") == {me["pt"].id}
        assert _ids(c, "SELECT id FROM clinical.condition") == {me["problem"].id}
        assert _ids(c, "SELECT id FROM clinical.observation") == {me["result"].id}
        assert _ids(c, "SELECT id FROM clinical.encounter") == {me["enc"].id}
        names = _ids(c, "SELECT patient_id FROM clinical.human_name WHERE patient_id IS NOT NULL")
        assert names == {me["pt"].id}
        components = c.execute(text("SELECT count(*) FROM clinical.observation_component")
                               ).scalar_one()
        assert components == 2                            # through the visible parent only
        assert other["pt"].id not in _ids(c, "SELECT subject_patient_id FROM clinical.condition")


def test_without_a_session_patient_the_portal_sees_no_chart(portal_engine: Engine,
                                                            chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                  {"t": str(chart["tenant"])})
        assert c.execute(text("SELECT count(*) FROM clinical.patient")).scalar_one() == 0
        assert c.execute(text("SELECT count(*) FROM clinical.condition")).scalar_one() == 0


# ===================================================================== hidden (D86)
def test_drafts_entered_in_error_and_non_final_results_are_hidden(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    me = chart["me"]
    pending = b.blood_pressure(s, me["pt"], me["enc"], status="preliminary")
    wrong = b.condition(s, me["pt"], me["enc"], code="R51.9", display="Headache")
    wrong.verification_status = "entered-in-error"
    wrong.clinical_status = None
    b.prescription(s, me["pt"], me["enc"], chart["ctx"])            # a draft
    signed_rx = b.prescription(s, me["pt"], me["enc"], chart["ctx"])
    signed_rx.dosage_instruction[0].patient_instruction = "Take with food"
    b.sign_prescription(s, signed_rx, chart["ctx"])
    signed_note = b.note(s, me["pt"], me["enc"], chart["ctx"])
    b.sign_note(s, signed_note, chart["ctx"])
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        observations = _ids(c, "SELECT id FROM clinical.observation")
        assert me["result"].id in observations and pending.id not in observations
        assert wrong.id not in _ids(c, "SELECT id FROM clinical.condition")
        assert _ids(c, "SELECT id FROM clinical.medication_request") == {signed_rx.id}
        assert _ids(c, "SELECT id FROM clinical.dosage") == {
            d.id for d in signed_rx.dosage_instruction}           # a draft's rows go with it
        # The sig and the patient instructions are the prescription's own, not notes on it.
        assert c.execute(text("SELECT text, patient_instruction FROM clinical.dosage")).one() == (
            "Take 1 tablet at migraine onset", "Take with food")
        assert _ids(c, "SELECT id FROM clinical.composition") == {signed_note.id}


def test_a_psychotherapy_note_is_never_shown(portal_engine: Engine,
                                             chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    me = chart["me"]
    note = b.note(s, me["pt"], me["enc"], chart["ctx"])
    note.meta_security = ["PSY"]                  # labelled before it is signed and frozen
    s.flush()
    b.sign_note(s, note, chart["ctx"])
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert note.id not in _ids(c, "SELECT id FROM clinical.composition")


# ======================================================================= holds (D90)
def _hold(s: Session, chart: dict[str, Any], **item: Any) -> Any:
    hold = M["release_hold"](patient_id=chart["me"]["pt"].id, reason="patient-request",
                             held_by_user_id=chart["ctx"]["user"].id, **item)
    s.add(hold)
    s.flush()
    return hold


def test_a_held_item_is_listed_without_its_content_or_reason(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    problem = chart["me"]["problem"]
    hold = _hold(s, chart, condition_id=problem.id)
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert problem.id not in _ids(c, "SELECT id FROM clinical.condition")
        held = c.execute(text("SELECT * FROM admin.portal_held_items()")).all()
        assert [(r.item_type, r.item_id) for r in held] == [("Condition", problem.id)]
        assert _ids(c, "SELECT id FROM admin.release_hold") == {hold.id}
        assert _refused(c, "SELECT reason FROM admin.release_hold") == DENIED
        assert _refused(c, "SELECT held_by_user_id FROM admin.release_hold") == DENIED
    hold.lifted_at, hold.lifted_by_user_id = dt.datetime.now(dt.UTC), chart["ctx"]["user"].id
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert problem.id in _ids(c, "SELECT id FROM clinical.condition")
        assert not c.execute(text("SELECT * FROM admin.portal_held_items()")).all()


def test_a_hold_is_on_one_item_of_the_same_patient_and_a_lifted_hold_is_final(
        chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    with fails(s, "23514", "ck_release_hold_one_item"):
        _hold(s, chart)                                        # on nothing
    with fails(s, "23503"):
        _hold(s, chart, condition_id=chart["other"]["problem"].id)
    hold = _hold(s, chart, condition_id=chart["me"]["problem"].id)
    hold.lifted_at, hold.lifted_by_user_id = dt.datetime.now(dt.UTC), chart["ctx"]["user"].id
    s.flush()
    with fails(s, "P0001", message="lifted and no longer changes"):
        hold.lifted_at = None
        hold.lifted_by_user_id = None
        s.flush()


# ============================================================ staff and what's never read
def test_staff_details_and_clinicians_records_stay_out_of_reach(
        portal_engine: Engine, chart: dict[str, Any], admin_engine: Engine) -> None:
    practitioner = chart["ctx"]["practitioner"]
    with admin_engine.begin() as c:                      # the touch trigger names its table
        c.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        c.execute(text("INSERT INTO clinical.address (id, tenant_id, practitioner_id, line, city, "
                       "state, postal_code, country, use) VALUES (gen_random_uuid(), :t, :p, "
                       "ARRAY['1 Home Street'], 'Springfield', 'IL', '62704', 'US', 'home')"),
                  {"t": chart["tenant"], "p": practitioner.id})
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        assert practitioner.id in _ids(c, "SELECT id FROM clinical.practitioner")
        assert _ids(c, "SELECT practitioner_id FROM clinical.human_name "
                       "WHERE practitioner_id IS NOT NULL") == {practitioner.id}
        assert not _ids(c, "SELECT id FROM clinical.address WHERE practitioner_id IS NOT NULL")
        for sql in ("SELECT birth_date FROM clinical.practitioner",
                    "SELECT * FROM clinical.provenance",
                    "SELECT * FROM clinical.fhir_resource_history",
                    "SELECT * FROM clinical.annotation",
                    "SELECT * FROM clinical.detected_issue",
                    "SELECT * FROM admin.app_user",
                    "SELECT * FROM admin.portal_session",
                    "SELECT * FROM audit.audit_event",
                    "SELECT * FROM audit.break_glass_access",
                    "SELECT tax_id_ref FROM admin.facility"):
            assert _refused(c, sql) == DENIED, sql


def test_the_portal_role_never_deletes(admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        tables = c.execute(text(
            "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables "
            "WHERE schemaname IN ('clinical', 'admin', 'audit', 'public')")).scalars().all()
        for table in tables:
            for p in ("DELETE", "TRUNCATE"):
                assert not c.execute(text("SELECT has_table_privilege('shri_portal', :t, :p)"),
                                     {"t": table, "p": p}).scalar_one(), (table, p)


# ===================================================================== bookings (D93)
def _book(c: Connection, chart: dict[str, Any], who: str = "me", hours: int = 72) -> uuid.UUID:
    aid = uuid.uuid4()
    start = dt.datetime.now(dt.UTC).replace(microsecond=0) + dt.timedelta(hours=hours)
    c.execute(text("INSERT INTO clinical.appointment (id, tenant_id, status, subject_patient_id, "
                   "start, \"end\", meta_security, extension) VALUES (:a, :t, 'booked', :p, :s, "
                   ":e, '{}', '[]')"),
              {"a": aid, "t": chart["tenant"], "p": chart[who]["pt"].id, "s": start,
               "e": start + dt.timedelta(minutes=20)})
    for actor in ("actor_patient_id", "actor_practitioner_id"):
        value = chart[who]["pt"].id if actor == "actor_patient_id" else \
            chart["ctx"]["practitioner"].id
        c.execute(text(f"INSERT INTO clinical.appointment_participant (id, tenant_id, "
                       f"appointment_id, {actor}, required, status) VALUES (gen_random_uuid(), "
                       ":t, :a, :v, 'required', 'accepted')"),
                  {"t": chart["tenant"], "a": aid, "v": value})
    return aid


def test_a_patient_books_and_cancels_their_own_visit_and_is_its_author(
        portal_engine: Engine, chart: dict[str, Any], admin_engine: Engine) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        aid = _book(c, chart)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        c.execute(text("UPDATE clinical.appointment SET status = 'cancelled', ext_cancelled_at "
                       "= now(), cancelation_reason_text = 'Feeling better' WHERE id = :a"),
                  {"a": aid})
    with admin_engine.connect() as c:
        rows = c.execute(text("SELECT version_id, recorded_by_user_id, recorded_by_patient_id "
                              "FROM clinical.fhir_resource_history WHERE resource_id = :a "
                              "ORDER BY version_id"), {"a": aid}).all()
    assert [tuple(r) for r in rows] == [(1, None, chart["me"]["pt"].id),
                                        (2, None, chart["me"]["pt"].id)]


def test_a_patient_cannot_book_for_someone_else_or_move_a_visit_on(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.connect() as c:
        _as_patient(c, chart)
        assert _refused(c, "INSERT INTO clinical.appointment (id, tenant_id, status, "
                        "subject_patient_id, start, \"end\", meta_security, extension) VALUES "
                        "(gen_random_uuid(), :t, 'booked', :p, now() + interval '3 days', "
                        "now() + interval '3 days 20 minutes', '{}', '[]')",
                        {"t": chart["tenant"], "p": chart["other"]["pt"].id}) == DENIED
        aid = _book(c, chart)
        assert _refused(c, "UPDATE clinical.appointment SET status = 'fulfilled' WHERE id = :a",
                        {"a": aid}) == DENIED
        assert _refused(c, "UPDATE clinical.appointment SET start = start + interval '1 hour' "
                        "WHERE id = :a", {"a": aid}) == DENIED
        c.rollback()


def test_busy_times_show_when_a_provider_is_booked_and_nothing_else(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    with portal_engine.begin() as c:
        _as_patient(c, chart, "other")
        _book(c, chart, "other", hours=48)
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        busy = c.execute(text("SELECT * FROM admin.portal_busy_times(:p, now(), "
                              "now() + interval '7 days')"),
                         {"p": chart["ctx"]["practitioner"].id}).all()
        assert len(busy) == 1 and set(busy[0]._fields) == {"start_at", "end_at"}
        assert _refused(c, "SELECT * FROM admin.portal_busy_times(:p, now(), now() + "
                        "interval '90 days')", {"p": chart["ctx"]["practitioner"].id}) == "22023"


# ============================================================ change requests (D91)
def test_change_requests_are_the_patients_own_and_the_front_desk_decides(
        portal_engine: Engine, chart: dict[str, Any], app_engine: Engine) -> None:
    rid = uuid.uuid4()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        c.execute(text("INSERT INTO admin.portal_change_request (id, tenant_id, patient_id, "
                       "changes, note) VALUES (:i, :t, :p, CAST(:c AS jsonb), 'New phone')"),
                  {"i": rid, "t": chart["tenant"], "p": chart["me"]["pt"].id,
                   "c": '{"phones": [{"number": "+12175550199", "use": "mobile"}]}'})
    with portal_engine.connect() as c:
        _as_patient(c, chart)
        assert _refused(c, "INSERT INTO admin.portal_change_request (id, tenant_id, patient_id, "
                        "changes) VALUES (gen_random_uuid(), :t, :p, '{\"email\": \"x\"}')",
                        {"t": chart["tenant"], "p": chart["other"]["pt"].id}) == DENIED
        assert _refused(c, "UPDATE admin.portal_change_request SET status = 'accepted'") == \
            DENIED
        c.rollback()
    with portal_engine.begin() as c:
        _as_patient(c, chart, "other")
        assert not _ids(c, "SELECT id FROM admin.portal_change_request")
    s = open_session(app_engine, chart["tenant"])
    try:
        s.execute(text("UPDATE admin.portal_change_request SET status = 'accepted', decided_at "
                       "= now(), decided_by_user_id = :u WHERE id = :i"),
                  {"u": chart["ctx"]["user"].id, "i": rid})
        s.commit()
        with fails(s, "P0001", message="no longer changes"):
            s.execute(text("UPDATE admin.portal_change_request SET decision_note = 'later' "
                           "WHERE id = :i"), {"i": rid})
    finally:
        conn = s.bind
        s.close()
        conn.close()  # type: ignore[union-attr]
