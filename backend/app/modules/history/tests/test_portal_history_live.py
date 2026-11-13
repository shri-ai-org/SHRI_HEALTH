"""The patient portal's own history reads (listPortalProblems, getPortalProblem,
listPortalAllergies, getPortalAllergy, listPortalVitals) against a live database: the real app
with the portal as ``shri_portal`` and the patient development sign-in (X-Dev-Patient, D108).
Records are written through Anand's helpers, as the demo seed writes them. Synthetic data only."""

from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.db import Database
from app.db import fhir_store as fs
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url
from app.modules.scheduling.tests.portal_live import PortalChart, audit_rows, portal_client

from .history_seed import seed_history

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/portal/me"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
SNOMED = "http://snomed.info/sct"


def _clinician(chart: PortalChart) -> uuid.UUID:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            user = uuid.uuid4()
            c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                      {"t": str(chart.practice.clinic)})
            c.execute(text("INSERT INTO admin.app_user (id, tenant_id, keycloak_subject, username, "
                           "display_name) VALUES (:i, :t, :s, :u, 'Test clinician (synthetic)')"),
                      {"i": user, "t": chart.practice.clinic, "s": str(uuid.uuid4()),
                       "u": f"clin.{user.hex[:8]}"})
        return user
    finally:
        admin.dispose()


async def _write(chart: PortalChart, user: uuid.UUID, patient: uuid.UUID) -> dict[str, uuid.UUID]:
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_app")
    store = fs.SqlFhirStore()
    try:
        async with database.tenant_session(chart.practice.clinic, user) as db:
            hives = fs.Coded(system=SNOMED, code="247472004", display="Hives")
            allergy = await store.create_allergy(db, fs.AllergyIn(
                patient_id=patient, code=fs.Coded(system=RXNORM, code="723", display="amoxicillin"),
                type="allergy", categories=("medication",), criticality="high",
                reactions=(fs.ReactionIn(manifestations=(hives,), severity="moderate"),)))
            wrong = await store.create_allergy(db, fs.AllergyIn(
                patient_id=patient,
                code=fs.Coded(system=RXNORM, code="7980", display="penicillin")))
            await store.allergy_entered_in_error(db, wrong.id, fs.Reason(text="Wrong chart."))
            older = dt.datetime(2026, 10, 1, 17, 0, tzinfo=dt.UTC)
            newer = dt.datetime(2026, 10, 27, 17, 0, tzinfo=dt.UTC)
            await store.record_vitals(db, patient, None, (
                fs.VitalIn(type="heart-rate", value=fs.Measured(Decimal("72"), "/min")),),
                effective_at=older)
            bp = await store.record_vitals(db, patient, None, (
                fs.VitalIn(type="blood-pressure", systolic=fs.Measured(Decimal("128"), "mm[Hg]"),
                           diastolic=fs.Measured(Decimal("82"), "mm[Hg]")),),
                effective_at=newer)
            await db.commit()
    finally:
        await database.dispose()
    return {"allergy": allergy.id, "wrong": wrong.id, "bp": bp[0].id}


def _seed(chart: PortalChart) -> dict[str, Any]:
    user = _clinician(chart)
    history = seed_history(chart.practice.clinic, user, chart.a)
    ids = asyncio.run(_write(chart, user, chart.a))
    return {"problem": history.problem, "asthma": history.asthma, **ids}


def test_my_problems_allergies_and_vitals(portal_app: Any, portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    problems = me.get(f"{API}/problems")
    assert problems.status_code == 200, problems.text
    (problem,) = problems.json()["items"]                # entered-in-error asthma left out
    assert problem["id"] == str(seeded["problem"]) and problem["releaseStatus"] == "available"
    assert problem["display"] == "Essential (primary) hypertension"
    assert problem["clinicalStatus"] == "active" and problem["onsetDate"] == "2019-04"
    assert me.get(f"{API}/problems/{seeded['problem']}").json() == problem
    assert me.get(f"{API}/problems/{seeded['asthma']}").status_code == 404

    allergies = me.get(f"{API}/allergies")
    assert allergies.status_code == 200, allergies.text
    (allergy,) = allergies.json()["items"]               # entered-in-error penicillin left out
    assert allergy["display"] == "amoxicillin" and allergy["criticality"] == "high"
    assert allergy["reactions"] == [{"manifestations": ["Hives"], "severity": "moderate"}]
    assert me.get(f"{API}/allergies/{seeded['allergy']}").json() == allergy
    assert me.get(f"{API}/allergies/{seeded['wrong']}").status_code == 404

    vitals = me.get(f"{API}/vitals").json()["items"]
    assert [v["type"] for v in vitals] == ["blood-pressure", "heart-rate"]  # newest first
    assert vitals[0]["systolic"] == {"value": 128.0, "unit": "mm[Hg]"}
    assert vitals[0]["diastolic"] == {"value": 82.0, "unit": "mm[Hg]"} and "value" not in vitals[0]
    assert vitals[1]["value"] == {"value": 72.0, "unit": "/min"}
    only = me.get(f"{API}/vitals", params={"type": "heart-rate"}).json()["items"]
    assert [v["type"] for v in only] == ["heart-rate"]
    window = me.get(f"{API}/vitals", params={"dateFrom": "2026-10-20",
                                             "dateTo": "2026-10-31"}).json()["items"]
    assert [v["id"] for v in window] == [str(seeded["bp"])]
    page = me.get(f"{API}/vitals", params={"limit": 1}).json()
    assert len(page["items"]) == 1 and page["nextCursor"]
    rows = audit_rows(portal_chart.practice.clinic)
    assert any(r.patient_id == portal_chart.a and r.category == "phi-read" for r in rows)


def test_another_patients_records_do_not_exist(portal_app: Any,
                                               portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    other = portal_client(portal_app, portal_chart, portal_chart.b)
    for path in ("problems", "allergies", "vitals"):
        listed = other.get(f"{API}/{path}")
        assert listed.status_code == 200 and listed.json()["items"] == [], path
    assert other.get(f"{API}/problems/{seeded['problem']}").status_code == 404
    assert other.get(f"{API}/allergies/{seeded['allergy']}").status_code == 404


def test_bad_parameters_and_no_patient_session(portal_app: Any,
                                               portal_chart: PortalChart) -> None:
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    for params in ({"limit": 0}, {"type": "mood"}, {"dateFrom": "13/11/2026"}):
        assert me.get(f"{API}/vitals", params=params).status_code == 422, params
    assert me.get(f"{API}/problems", params={"cursor": "bm90LWFuLW9mZnNldA"}).status_code == 400
    for path in ("problems", "allergies", "vitals"):        # a staff session isn't a patient's
        refused = portal_app.get(f"{API}/{path}", headers={"X-Dev-User": "md"})
        assert refused.status_code in (401, 403), (path, refused.status_code)


def _hold(chart: PortalChart, user: uuid.UUID, problem: uuid.UUID, *, lift: bool = False) -> None:
    """A clinician's hold on the problem (D90), or its lifting, written as the migrator would."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            c.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                      {"t": str(chart.practice.clinic)})
            if lift:
                c.execute(text("UPDATE admin.release_hold SET lifted_at = now(), "
                               "lifted_by_user_id = :u WHERE condition_id = :c "
                               "AND lifted_at IS NULL"), {"u": user, "c": problem})
            else:
                c.execute(text("INSERT INTO admin.release_hold (id, tenant_id, patient_id, "
                               "condition_id, reason, held_by_user_id) VALUES (:i, :t, :p, :c, "
                               "'patient-request', :u)"),
                          {"i": uuid.uuid4(), "t": chart.practice.clinic, "p": chart.a,
                           "c": problem, "u": user})
    finally:
        admin.dispose()


def test_a_held_problem_is_listed_as_held_with_its_id_only(portal_app: Any,
                                                         portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    user = _clinician(portal_chart)
    _hold(portal_chart, user, seeded["problem"])
    _hold(portal_chart, user, seeded["asthma"])        # entered-in-error: never listed, held or not
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    listed = me.get(f"{API}/problems")
    assert listed.status_code == 200, listed.text
    held = {"id": str(seeded["problem"]), "releaseStatus": "held"}
    assert listed.json()["items"] == [held]            # no name, status, dates or reason
    assert me.get(f"{API}/problems/{seeded['asthma']}").status_code == 404
    assert me.get(f"{API}/problems/{seeded['problem']}").json() == held
    assert "patient-request" not in listed.text
    # Another patient never sees it, held or not.
    other = portal_client(portal_app, portal_chart, portal_chart.b)
    assert other.get(f"{API}/problems").json()["items"] == []
    assert other.get(f"{API}/problems/{seeded['problem']}").status_code == 404
    # Lifted: the problem is back, in full.
    _hold(portal_chart, user, seeded["problem"], lift=True)
    (problem,) = me.get(f"{API}/problems").json()["items"]
    assert problem["releaseStatus"] == "available"
    assert problem["display"] == "Essential (primary) hypertension"
