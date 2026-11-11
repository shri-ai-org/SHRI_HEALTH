"""The family, social and surgical history helpers (FRS FR-PAT-03) against a live database, as
shri_app through the core's tenant session. Fixtures are test_fhir_store's; the visit is
test_fhir_store_visits'."""
from __future__ import annotations

from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Engine

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _create, _rows, clinic, database, session
from app.db.tests.test_fhir_store_visits import WHY, _facility, _visit

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["_facility", "clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
FATHER = fs.Coded(system=systems.V3_ROLE_CODE, code="FTH", display="father")
HEART_ATTACK = fs.Coded(system=systems.SNOMED, code="22298006",
                        display="Myocardial infarction")
SMOKING = fs.Coded(system=systems.LOINC, code="72166-2", display="Tobacco smoking status")
FORMER = fs.Coded(system=systems.SNOMED, code="8517006", display="Former smoker")
APPENDECTOMY = fs.Coded(system=systems.SNOMED, code="80146002", display="Appendectomy")


async def _write(database: Database, clinic: dict[str, Any], call: str, data: Any
                 ) -> fs.Written:
    async with session(database, clinic) as s:
        w: fs.Written = await getattr(STORE, call)(s, data)
        await s.commit()
    return w


async def test_a_relative_with_conditions_and_a_note(database: Database, clinic: dict[str, Any],
                                                     admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _write(database, clinic, "create_family_history", fs.FamilyHistoryIn(
        patient_id=patient.id, relationship=FATHER, sex="male", deceased=True,
        conditions=(fs.FamilyConditionIn(code=HEART_ATTACK, onset_age=62,
                                         contributed_to_death=True),),
        note="Paternal side."))
    row = _rows(admin_engine, "SELECT f.*, (SELECT array_agg(text) FROM clinical.annotation "
                "WHERE family_member_history_id = f.id) AS notes FROM "
                "clinical.family_member_history f WHERE f.id = :f", f=w.id)[0]
    assert (row.status, row.relationship_code, row.sex_text, row.deceased_boolean, row.notes,
            row.created_by_user_id) == ("completed", "FTH", "male", True, ["Paternal side."],
                                        clinic["user"])
    cond = _rows(admin_engine, "SELECT * FROM clinical.family_member_history_condition "
                 "WHERE family_member_history_id = :f", f=w.id)
    assert [(c.code_code, c.onset_age_value, c.onset_age_code, c.contributed_to_death)
            for c in cond] == [("22298006", Decimal(62), "a", True)]


@pytest.mark.parametrize(("kw", "field"), [
    ({}, "conditions"),                                  # nothing known, yet not health-unknown
    ({"status": "entered-in-error"}, "status"),
    ({"status": "health-unknown", "sex": "M"}, "sex"),
])
async def test_what_a_family_history_refuses(database: Database, clinic: dict[str, Any],
                                             kw: dict[str, Any], field: str) -> None:
    patient = await _create(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput) as refused:
            await STORE.create_family_history(s, fs.FamilyHistoryIn(
                patient_id=patient.id, relationship=FATHER, **kw))
    assert refused.value.field == field


@pytest.mark.parametrize(("value", "column", "stored"), [
    (FORMER, "value_codeable_concept_code", "8517006"),
    (fs.Measured(Decimal("2"), "/d"), "value_quantity_value", Decimal("2")),
    ("Quit in 2015.", "value_string", "Quit in 2015."),
])
async def test_social_history_keeps_its_answer(database: Database, clinic: dict[str, Any],
                                               admin_engine: Engine, value: Any, column: str,
                                               stored: Any) -> None:
    patient, enc = await _visit(database, clinic)
    w = await _write(database, clinic, "record_social_history", fs.SocialHistoryIn(
        patient_id=patient.id, code=SMOKING, value=value, effective="2015",
        encounter_id=enc.id))
    row = _rows(admin_engine, "SELECT o.*, (SELECT array_agg(category_code) FROM "
                "clinical.observation_category WHERE observation_id = o.id) AS categories "
                "FROM clinical.observation o WHERE o.id = :o", o=w.id)[0]
    assert (getattr(row, column), row.categories, row.status, row.encounter_id) == (
        stored, ["social-history"], "final", enc.id)
    assert (row.effective_period_start.date().isoformat(),
            row.effective_period_end.date().isoformat()) == ("2015-01-01", "2015-12-31")


@pytest.mark.parametrize(("kw", "field"), [
    ({"code": HEART_ATTACK}, "code"),                    # what was asked is LOINC
    ({"effective": "2015-13"}, "effectiveDate"),
    ({"effective": "2999"}, "effectiveDate"),
])
async def test_what_social_history_refuses(database: Database, clinic: dict[str, Any],
                                           kw: dict[str, Any], field: str) -> None:
    patient = await _create(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput) as refused:
            await STORE.record_social_history(s, fs.SocialHistoryIn(
                **{"patient_id": patient.id, "code": SMOKING, "value": FORMER, **kw}))
    assert refused.value.field == field


async def test_a_past_surgery_with_its_site(database: Database, clinic: dict[str, Any],
                                            admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _write(database, clinic, "create_surgical_history", fs.SurgicalHistoryIn(
        patient_id=patient.id, code=APPENDECTOMY, performed="2010-06-03",
        body_site=fs.Coded(system=systems.SNOMED, code="66754008", display="Appendix"),
        note="No complications."))
    row = _rows(admin_engine, "SELECT p.*, (SELECT array_agg(body_site_code) FROM "
                "clinical.procedure_body_site WHERE procedure_id = p.id) AS sites, (SELECT "
                "array_agg(text) FROM clinical.annotation WHERE procedure_id = p.id) AS notes "
                "FROM clinical.procedure p WHERE p.id = :p", p=w.id)[0]
    assert (row.status, row.category_code, row.code_code, row.sites, row.notes) == (
        "completed", "387713003", "80146002", ["66754008"], ["No complications."])
    assert row.performed_date_time.date().isoformat() == "2010-06-03"
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput) as refused:
            await STORE.create_surgical_history(s, fs.SurgicalHistoryIn(
                patient_id=patient.id, code=APPENDECTOMY, performed="06/2010"))
    assert refused.value.field == "performedDate"


async def test_entered_in_error_keeps_each_with_its_provenance(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    written = [
        ("FamilyMemberHistory", "family_history_entered_in_error", await _write(
            database, clinic, "create_family_history", fs.FamilyHistoryIn(
                patient_id=patient.id, relationship=FATHER, status="health-unknown"))),
        ("Observation", "social_history_entered_in_error", await _write(
            database, clinic, "record_social_history", fs.SocialHistoryIn(
                patient_id=patient.id, code=SMOKING, value=FORMER))),
        ("Procedure", "surgical_history_entered_in_error", await _write(
            database, clinic, "create_surgical_history", fs.SurgicalHistoryIn(
                patient_id=patient.id, code=APPENDECTOMY, performed="2010"))),
    ]
    for rtype, call, w in written:
        async with session(database, clinic) as s:
            gone = await getattr(STORE, call)(s, w.id, WHY, if_version=w.version)
            await s.commit()
        provenance = _rows(admin_engine, "SELECT target_version_id FROM clinical.provenance "
                           "WHERE target_resource_type = :t AND target_id = :i", t=rtype, i=w.id)
        assert [p.target_version_id for p in provenance] == [gone.version], rtype
        async with session(database, clinic) as s:
            with pytest.raises(fs.InvalidTransition):
                await getattr(STORE, call)(s, w.id, WHY)
    async with session(database, clinic) as s:                 # each only for its own kind
        with pytest.raises(fs.ResourceNotFound):
            await STORE.social_history_entered_in_error(s, written[2][2].id, WHY)
        with pytest.raises(fs.ResourceNotFound):
            await STORE.surgical_history_entered_in_error(s, written[1][2].id, WHY)


async def test_another_clinic_sees_none_of_it(database: Database, clinic: dict[str, Any],
                                              admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _write(database, clinic, "create_surgical_history", fs.SurgicalHistoryIn(
        patient_id=patient.id, code=APPENDECTOMY, performed="2010"))
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.record_social_history(s, fs.SocialHistoryIn(
                patient_id=patient.id, code=SMOKING, value=FORMER))
        with pytest.raises(fs.ResourceNotFound):
            await STORE.surgical_history_entered_in_error(s, w.id, WHY)
