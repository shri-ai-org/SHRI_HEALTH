"""Migration 0022: admin.portal_held_records(), the portal's held-item markers (D90, A9), as
shri_portal: its own patient's holds only, every hold type, active and lifted holds told apart,
only items the portal would show once released, never the reason or the clinician, no writes,
and EXECUTE for shri_portal only. 0011's held-items function stays exactly as it was, and the
portal's visit-summary read that uses it still runs. Synthetic data only."""
from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from sqlalchemy import Connection, Engine, text
from sqlalchemy.orm import Session

from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.test_portal_access import (
    DENIED,
    _as_patient,
    _hold,
    _refused,
    chart,
    portal_engine,
)
from app.modules.encounters.portal_repository import _HELD as VISIT_SUMMARY_HELD

__all__ = ["chart", "portal_engine"]       # fixtures, used by name
M = MAPPERS
HELD = "SELECT item_type, item_id, patient_id, hold_active FROM admin.portal_held_records()"


def _document(s: Session, pt: Any, **kw: Any) -> Any:
    doc = M["document_reference"](status=kw.pop("status", "current"), type_system=systems.LOINC,
                                  type_code="34133-9", subject_patient_id=pt.id, date=b.NOW,
                                  ext_origin="upload", **kw)
    s.add(doc)
    s.flush()
    return doc


def _report(s: Session, pt: Any, status: str = "final") -> Any:
    report = M["diagnostic_report"](status=status, code_system=systems.LOINC, code_code="24331-1",
                                    subject_patient_id=pt.id, effective_date_time=b.NOW,
                                    issued=b.NOW if status == "final" else None)
    s.add(report)
    s.flush()
    return report


def _held(c: Connection, chart: dict[str, Any], who: str = "me") -> set[tuple[Any, ...]]:
    _as_patient(c, chart, who)
    return {tuple(r) for r in c.execute(text(HELD))}


@pytest.mark.db
def test_every_hold_type_of_the_patient_is_returned_with_whether_it_is_active(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    me = chart["me"]
    doc, report = _document(s, me["pt"]), _report(s, me["pt"])
    _hold(s, chart, condition_id=me["problem"].id)
    _hold(s, chart, document_reference_id=doc.id)
    lifted = _hold(s, chart, diagnostic_report_id=report.id)
    lifted.lifted_at, lifted.lifted_by_user_id = dt.datetime.now(dt.UTC), chart["ctx"]["user"].id
    s.commit()
    with portal_engine.begin() as c:
        assert _held(c, chart) == {("Condition", me["problem"].id, me["pt"].id, True),
                                   ("DocumentReference", doc.id, me["pt"].id, True),
                                   ("DiagnosticReport", report.id, me["pt"].id, False)}


@pytest.mark.db
def test_a_held_problem_shows_up_and_stays_hidden_from_the_problem_list(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    problem = chart["me"]["problem"]
    _hold(s, chart, condition_id=problem.id)
    s.commit()
    with portal_engine.begin() as c:
        assert ("Condition", problem.id, chart["me"]["pt"].id, True) in _held(c, chart)
        assert problem.id not in {r[0] for r in c.execute(text(
            "SELECT id FROM clinical.condition"))}


@pytest.mark.db
def test_another_patients_hold_never_shows(portal_engine: Engine,
                                            chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    other = chart["other"]
    hold = M["release_hold"](patient_id=other["pt"].id, reason="risk-of-harm",
                             held_by_user_id=chart["ctx"]["user"].id,
                             condition_id=other["problem"].id)
    s.add(hold)
    s.commit()
    with portal_engine.begin() as c:
        assert _held(c, chart, "me") == set()
        assert _held(c, chart, "other") == {("Condition", other["problem"].id, other["pt"].id,
                                             True)}
        c.execute(text("SELECT set_config('app.current_patient_id', '', true)"))
        assert c.execute(text(HELD)).all() == []           # no session patient, nothing


@pytest.mark.db
def test_only_items_the_portal_would_show_once_released(portal_engine: Engine,
                                                        chart: dict[str, Any]) -> None:
    """Vimal's gap on #85: D24 (entered-in-error is never patient-facing), the problem list
    only, no draft or entered-in-error document, no psychotherapy note (D86), final results
    only (Q32)."""
    s: Session = chart["s"]
    me = chart["me"]
    wrong = b.condition(s, me["pt"], me["enc"], code="R51.9", display="Headache")
    wrong.verification_status, wrong.clinical_status = "entered-in-error", None
    diagnosis = b.condition(s, me["pt"], me["enc"], code="J20.9", display="Acute bronchitis")
    diagnosis.category[0].category_code = "encounter-diagnosis"
    gone = _document(s, me["pt"], status="entered-in-error")
    psy = _document(s, me["pt"], meta_security=["PSY"])
    preliminary = _report(s, me["pt"], status="preliminary")
    s.flush()
    for item in ({"condition_id": wrong.id}, {"condition_id": diagnosis.id},
                 {"document_reference_id": gone.id}, {"document_reference_id": psy.id},
                 {"diagnostic_report_id": preliminary.id}):
        _hold(s, chart, **item)
    s.commit()
    with portal_engine.begin() as c:
        assert _held(c, chart) == set()


@pytest.mark.db
def test_the_reason_and_the_clinician_stay_unreadable_and_nothing_is_written(
        portal_engine: Engine, chart: dict[str, Any]) -> None:
    s: Session = chart["s"]
    hold = _hold(s, chart, condition_id=chart["me"]["problem"].id)
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        columns = c.execute(text("SELECT * FROM admin.portal_held_records()")).keys()
        assert list(columns) == ["item_type", "item_id", "patient_id", "hold_active"]
        for column in ("reason", "held_by_user_id", "held_at", "lifted_by_user_id"):
            assert _refused(c, f"SELECT {column} FROM admin.release_hold") == DENIED
        assert _refused(c, "UPDATE admin.release_hold SET lifted_at = now() WHERE id = :i",
                        {"i": hold.id}) == DENIED
        assert _refused(c, "DELETE FROM admin.release_hold WHERE id = :i",
                        {"i": hold.id}) == DENIED
        assert _refused(c, "INSERT INTO admin.release_hold (patient_id, reason) "
                           "VALUES (:p, 'patient-request')",
                        {"p": chart["me"]["pt"].id}) == DENIED


@pytest.mark.db
def test_only_the_portal_role_may_execute_it_and_it_runs_as_the_migrator(
        admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        fn = c.execute(text(
            "SELECT p.prosecdef, p.provolatile, p.proconfig, r.rolname AS owner, "
            "p.proacl::text[] AS acl FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner "
            "WHERE p.oid = 'admin.portal_held_records()'::regprocedure")).one()
        executors = {role for role in ("shri_portal", "shri_app", "shri_fhir_reader",
                                       "shri_integration", "shri_reporting", "shri_public",
                                       "shri_maintenance")
                     if c.execute(text("SELECT has_function_privilege(:r, "
                                       "'admin.portal_held_records()', 'EXECUTE')"),
                                  {"r": role}).scalar_one()}
    assert fn.prosecdef and fn.provolatile == "s" and fn.owner == "shri_migrator"
    assert fn.proconfig == ["search_path=pg_catalog, pg_temp"]
    assert not any(entry.startswith("=") for entry in fn.acl)        # nothing for PUBLIC
    assert executors == {"shri_portal"}


# ============================================================ 0011's function stays as it was
@pytest.mark.db
def test_the_old_function_is_unchanged(portal_engine: Engine, admin_engine: Engine,
                                       chart: dict[str, Any]) -> None:
    """Every active hold, with its type, ID and date, as 0011 wrote it: the portal's
    visit-summary read on main depends on it until it moves to portal_held_records()."""
    s: Session = chart["s"]
    me = chart["me"]
    wrong = b.condition(s, me["pt"], me["enc"], code="R51.9", display="Headache")
    wrong.verification_status, wrong.clinical_status = "entered-in-error", None
    doc, report = _document(s, me["pt"]), _report(s, me["pt"])
    _hold(s, chart, condition_id=wrong.id)
    _hold(s, chart, document_reference_id=doc.id)
    lifted = _hold(s, chart, diagnostic_report_id=report.id)
    lifted.lifted_at, lifted.lifted_by_user_id = dt.datetime.now(dt.UTC), chart["ctx"]["user"].id
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        rows = c.execute(text("SELECT * FROM admin.portal_held_items()"))
        assert list(rows.keys()) == ["item_type", "item_id", "item_date"]
        assert {tuple(r) for r in rows} == {("Condition", wrong.id, wrong.recorded_date),
                                            ("DocumentReference", doc.id, doc.date)}
    with admin_engine.connect() as c:
        fn = c.execute(text(
            "SELECT p.prosecdef, r.rolname AS owner, pg_get_function_result(p.oid) AS result "
            "FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner "
            "WHERE p.oid = 'admin.portal_held_items()'::regprocedure")).one()
    assert fn.prosecdef and fn.owner == "shri_migrator"
    assert fn.result == ("TABLE(item_type text, item_id uuid, "
                         "item_date timestamp with time zone)")


@pytest.mark.db
def test_the_visit_summary_held_read_on_main_still_runs(portal_engine: Engine,
                                                         chart: dict[str, Any]) -> None:
    """The encounters portal read's own query (its _HELD), as shri_portal, after 0022: no
    error, and a held visit summary is listed with its date."""
    s: Session = chart["s"]
    doc = _document(s, chart["me"]["pt"])
    _hold(s, chart, document_reference_id=doc.id)
    s.commit()
    with portal_engine.begin() as c:
        _as_patient(c, chart)
        rows = c.execute(VISIT_SUMMARY_HELD).mappings().all()
    assert [(r["item_id"], r["item_date"]) for r in rows] == [(doc.id, doc.date)]
