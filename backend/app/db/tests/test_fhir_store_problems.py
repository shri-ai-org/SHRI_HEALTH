"""The problem-list helpers (FRS FR-PAT-03: create, update and mark entered-in-error a Condition
with category ``problem-list-item``) against a live database, as shri_app through the core's
tenant session. Fixtures are test_fhir_store's; the visit is test_fhir_store_visits'."""
from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import Engine

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import MAPPERS as M
from app.db.models import systems
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, make_tenant
from app.db.tests.test_fhir_store import _create, _rows, clinic, database, session
from app.db.tests.test_fhir_store_visits import WHY, _facility, _visit

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["_facility", "clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
HYPERTENSION = fs.Coded(system=systems.ICD10CM, code="I10",
                        display="Essential (primary) hypertension")


async def _problem(database: Database, clinic: dict[str, Any], patient: Any, **kw: Any
                   ) -> fs.Written:
    async with session(database, clinic) as s:
        w = await STORE.create_problem(s, fs.ProblemIn(patient_id=patient.id,
                                                       code=HYPERTENSION, **kw))
        await s.commit()
    return w


def _stored(admin_engine: Engine, problem: Any) -> Any:
    return _rows(admin_engine,
                 "SELECT c.*, (SELECT array_agg(category_code) FROM clinical.condition_category "
                 "WHERE condition_id = c.id) AS categories, (SELECT array_agg(text) FROM "
                 "clinical.annotation WHERE condition_id = c.id) AS notes "
                 "FROM clinical.condition c WHERE c.id = :c", c=problem.id)[0]


@pytest.mark.parametrize(("onset", "stored"), [
    ("2019", "2019"), ("2019-02", "2019-02"), ("2019-02-14", "2019-02-14"), (None, None)])
async def test_a_problem_keeps_its_onset_as_given(database: Database, clinic: dict[str, Any],
                                                  admin_engine: Engine, onset: str | None,
                                                  stored: str | None) -> None:
    patient = await _create(database, clinic)
    w = await _problem(database, clinic, patient, onset=onset, note="Diagnosed elsewhere.")
    row = _stored(admin_engine, w)
    assert (row.categories, row.clinical_status, row.verification_status, row.notes) == (
        ["problem-list-item"], "active", "confirmed", ["Diagnosed elsewhere."])
    assert row.recorded_date is not None and row.created_by_user_id == clinic["user"]
    cond = M["condition"](onset_date_time=row.onset_date_time,
                        onset_period_start=row.onset_period_start,
                        onset_period_end=row.onset_period_end)
    assert fs.problem_dates(cond) == (stored, None)
    if onset == "2019":                                   # a whole year, queryable as a period
        assert (row.onset_period_start.date().isoformat(),
                row.onset_period_end.date().isoformat()) == ("2019-01-01", "2019-12-31")


async def test_resolving_a_problem_and_changing_its_note(database: Database,
                                                         clinic: dict[str, Any],
                                                         admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _problem(database, clinic, patient, onset="2019-02", note="First note.")
    async with session(database, clinic) as s:
        resolved = await STORE.update_problem(s, w.id, fs.ProblemChanges(
            clinical_status="resolved", abatement="2024", note="Resolved after weight loss."),
            if_version=w.version)
        await s.commit()
    assert resolved.version == w.version + 1
    row = _stored(admin_engine, w)
    cond = M["condition"](**{k: getattr(row, k) for k in (
        "onset_date_time", "onset_period_start", "onset_period_end", "abatement_date_time",
        "abatement_period_start", "abatement_period_end")})
    assert fs.problem_dates(cond) == ("2019-02", "2024")              # the onset is untouched
    assert (row.clinical_status, row.notes) == ("resolved", ["Resolved after weight loss."])
    async with session(database, clinic) as s:
        cleared = await STORE.update_problem(s, w.id, fs.ProblemChanges(note=None),
                                             if_version=resolved.version)
        await s.commit()
    assert _stored(admin_engine, w).notes is None and cleared.version == resolved.version + 1
    async with session(database, clinic) as s:
        with pytest.raises(fs.StaleVersion):
            await STORE.update_problem(s, w.id, fs.ProblemChanges(clinical_status="active"),
                                       if_version=w.version)


@pytest.mark.parametrize(("kw", "field"), [
    ({"onset": "2019-13"}, "onsetDate"),
    ({"onset": "19"}, "onsetDate"),
    ({"onset": "2020", "abatement": "2019", "clinical_status": "resolved"}, "abatementDate"),
    ({"abatement": "2024"}, "clinicalStatus"),           # still active: FHIR con-4
    ({"clinical_status": "cured"}, "clinicalStatus"),
    ({"verification_status": "entered-in-error"}, "verificationStatus"),
])
async def test_what_a_new_problem_refuses(database: Database, clinic: dict[str, Any],
                                          kw: dict[str, Any], field: str) -> None:
    patient = await _create(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput) as refused:
            await STORE.create_problem(s, fs.ProblemIn(patient_id=patient.id,
                                                       code=HYPERTENSION, **kw))
    assert refused.value.field == field


async def test_an_end_on_an_active_problem_is_refused_on_update_too(
        database: Database, clinic: dict[str, Any]) -> None:
    patient = await _create(database, clinic)
    w = await _problem(database, clinic, patient)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput) as refused:
            await STORE.update_problem(s, w.id, fs.ProblemChanges(abatement="2024"),
                                       if_version=w.version)
    assert refused.value.field == "clinicalStatus"


async def test_entered_in_error_keeps_the_row_with_its_provenance(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _problem(database, clinic, patient)
    async with session(database, clinic) as s:
        gone = await STORE.problem_entered_in_error(s, w.id, WHY, if_version=w.version)
        await s.commit()
    row = _stored(admin_engine, w)
    assert (row.verification_status, row.clinical_status) == ("entered-in-error", None)
    provenance = _rows(admin_engine, "SELECT target_version_id FROM clinical.provenance "
                       "WHERE target_resource_type = 'Condition' AND target_id = :c", c=w.id)
    assert [p.target_version_id for p in provenance] == [gone.version]   # who, why, which version
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.problem_entered_in_error(s, w.id, WHY, if_version=gone.version)
        with pytest.raises(fs.InvalidTransition):
            await STORE.update_problem(s, w.id, fs.ProblemChanges(clinical_status="active"),
                                       if_version=gone.version)


async def test_an_encounter_diagnosis_is_not_a_problem_here(database: Database,
                                                            clinic: dict[str, Any]) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        dx = await STORE.add_encounter_diagnosis(s, enc.id, fs.DiagnosisIn(code=HYPERTENSION))
        await s.commit()
    async with session(database, clinic) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.update_problem(s, dx.condition.id, fs.ProblemChanges(
                clinical_status="inactive"), if_version=dx.condition.version)
        with pytest.raises(fs.ResourceNotFound):
            await STORE.problem_entered_in_error(s, dx.condition.id, WHY)


async def test_a_problem_recorded_at_a_visit_names_it(database: Database,
                                                      clinic: dict[str, Any],
                                                      admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    w = await _problem(database, clinic, patient, encounter_id=enc.id)
    assert _stored(admin_engine, w).encounter_id == enc.id
    other = await _create(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidInput):                 # another patient's visit
            await STORE.create_problem(s, fs.ProblemIn(patient_id=other.id, code=HYPERTENSION,
                                                       encounter_id=enc.id))


async def test_another_clinic_sees_none_of_it(database: Database, clinic: dict[str, Any],
                                              admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    w = await _problem(database, clinic, patient)
    other = {**clinic, "tenant": make_tenant(admin_engine)}
    async with session(database, other) as s:
        with pytest.raises(fs.ResourceNotFound):
            await STORE.create_problem(s, fs.ProblemIn(patient_id=patient.id,
                                                       code=HYPERTENSION))
        with pytest.raises(fs.ResourceNotFound):
            await STORE.update_problem(s, w.id, fs.ProblemChanges(clinical_status="inactive"),
                                       if_version=w.version)
