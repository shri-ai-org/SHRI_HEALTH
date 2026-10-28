"""The visit write helpers (encounters, vitals, allergies, diagnoses) against a live database,
as shri_app through the core's tenant session. Fixtures are test_fhir_store's."""
from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Engine

from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_fhir_store import _create, _rows, clinic, database, session

pytestmark = [pytest.mark.db, SKIP_WITHOUT_DATABASE]
__all__ = ["clinic", "database"]   # fixtures, used by name

STORE = fs.SqlFhirStore()
NOW = dt.datetime(2026, 10, 26, 14, 0, tzinfo=dt.UTC)   # in the past
WHY = fs.Reason(text="Wrong patient")


async def _visit(database: Database, clinic: dict[str, Any], **kw: Any) -> tuple[Any, Any]:
    patient = await _create(database, clinic)
    facility = _rows_facility(clinic)
    async with session(database, clinic) as s:
        enc = await STORE.create_encounter(s, fs.EncounterIn(
            patient_id=patient.id, facility_id=facility, started_at=NOW,
            participants=(fs.ParticipantIn(practitioner_id=clinic["practitioner"]),),
            reasons=(fs.Coded(text="Headache"),), **kw))
        await s.commit()
    return patient, enc


def _rows_facility(clinic: dict[str, Any]) -> uuid.UUID:
    facility: uuid.UUID = clinic["facility"]
    return facility


@pytest.fixture(autouse=True)
def _facility(clinic: dict[str, Any], admin_engine: Engine) -> None:
    clinic["facility"] = _rows(admin_engine, "SELECT id FROM admin.facility WHERE tenant_id = :t",
                               t=clinic["tenant"])[0].id


# ====================================================================== Encounter
async def test_an_encounter_moves_through_its_statuses_with_history(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, enc = await _visit(database, clinic, self_pay=True)
    eid = {"e": enc.id}
    row = _rows(admin_engine, "SELECT status, class, ext_self_pay, period_start FROM "
                "clinical.encounter WHERE id = :e", **eid)[0]
    assert tuple(row) == ("arrived", "AMB", True, NOW)
    async with session(database, clinic) as s:
        started = await STORE.set_encounter_status(s, enc.id, "in-progress",
                                                   at=NOW + dt.timedelta(minutes=10),
                                                   if_version=enc.version)
        done = await STORE.set_encounter_status(s, enc.id, "finished",
                                                at=NOW + dt.timedelta(minutes=30))
        await s.commit()
    assert started.version == enc.version + 1 and done.version == started.version
    history = _rows(admin_engine, "SELECT status, period_end IS NULL AS open FROM clinical."
                    "encounter_status_history WHERE encounter_id = :e ORDER BY period_start",
                    **eid)
    assert [tuple(r) for r in history] == [("arrived", False), ("in-progress", False),
                                           ("finished", True)]
    assert _rows(admin_engine, "SELECT period_end FROM clinical.encounter WHERE id = :e",
                 **eid)[0].period_end == NOW + dt.timedelta(minutes=30)
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.encounter_participant WHERE "
                     "encounter_id = :e", **eid)) == 1


async def test_an_encounter_entered_in_error_has_its_provenance_and_stays_so(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        with pytest.raises(ValueError):
            await STORE.set_encounter_status(s, enc.id, "entered-in-error")
        w = await STORE.set_encounter_status(s, enc.id, "entered-in-error", reason=WHY)
        await s.commit()
    assert [tuple(r) for r in _rows(admin_engine, "SELECT target_version_id, reason_text FROM "
                                    "clinical.provenance WHERE target_id = :e", e=enc.id)] == [
        (w.version, "Wrong patient")]
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.set_encounter_status(s, enc.id, "arrived")


# ====================================================================== Vitals
async def test_vitals_are_stored_as_entered(database: Database, clinic: dict[str, Any],
                                            admin_engine: Engine) -> None:
    patient, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        written = await STORE.record_vitals(s, patient.id, enc.id, (
            fs.VitalIn("blood-pressure", systolic=fs.Measured(Decimal(128), "mm[Hg]"),
                       diastolic=fs.Measured(Decimal(82), "mm[Hg]")),
            fs.VitalIn("body-weight", value=fs.Measured(Decimal("154.3"), "[lb_av]")),
            fs.VitalIn("body-temperature", value=fs.Measured(Decimal("98.6"), "[degF]"))),
            effective_at=NOW)
        await s.commit()
    assert len(written) == 3
    obs = _rows(admin_engine, "SELECT code_code, value_quantity_value, value_quantity_code FROM "
                "clinical.observation WHERE encounter_id = :e ORDER BY code_code", e=enc.id)
    assert [tuple(r) for r in obs] == [("29463-7", Decimal("154.3"), "[lb_av]"),
                                       ("8310-5", Decimal("98.6"), "[degF]"),
                                       ("85354-9", None, None)]
    parts = _rows(admin_engine, "SELECT c.code_code, c.value_quantity_value FROM clinical."
                  "observation_component c JOIN clinical.observation o ON o.id = "
                  "c.observation_id WHERE o.encounter_id = :e ORDER BY c.sequence", e=enc.id)
    assert [tuple(r) for r in parts] == [("8480-6", 128), ("8462-4", 82)]


async def test_vitals_that_cannot_be_recorded(database: Database,
                                              clinic: dict[str, Any]) -> None:
    patient, enc = await _visit(database, clinic)
    hr = fs.VitalIn("heart-rate", value=fs.Measured(Decimal(72), "/min"))
    async with session(database, clinic) as s:
        for vitals, at in (((hr, hr), NOW),                            # one per type
                           ((fs.VitalIn("blood-pressure",
                                        systolic=fs.Measured(Decimal(120), "mm[Hg]")),), NOW),
                           ((fs.VitalIn("pulse", value=hr.value),), NOW),
                           ((hr,), dt.datetime.now(dt.UTC) + dt.timedelta(hours=1))):
            with pytest.raises(ValueError):
                await STORE.record_vitals(s, patient.id, enc.id, vitals, effective_at=at)


# ====================================================================== Allergy
async def test_an_allergy_with_reactions_is_updated_and_entered_in_error(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    patient = await _create(database, clinic)
    penicillin = fs.Coded(system=systems.RXNORM, code="7980", display="Penicillin G")
    hives = fs.Coded(system=systems.SNOMED, code="247472004", display="Hives")
    async with session(database, clinic) as s:
        w = await STORE.create_allergy(s, fs.AllergyIn(
            patient_id=patient.id, code=penicillin, categories=("medication",),
            criticality="high", reactions=(fs.ReactionIn(manifestations=(hives,),
                                                          severity="moderate"),),
            note="Since childhood"))
        await s.commit()
    aid = {"a": w.id}
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.allergy_reaction_manifestation m "
                     "JOIN clinical.allergy_intolerance_reaction r ON r.id = m.reaction_id "
                     "WHERE r.allergy_intolerance_id = :a", **aid)) == 1
    async with session(database, clinic) as s:
        w2 = await STORE.update_allergy(s, w.id, fs.AllergyChanges(reactions=(), note=None),
                                        if_version=w.version)
        await s.commit()
    assert w2.version == w.version + 1
    assert not _rows(admin_engine, "SELECT 1 FROM clinical.allergy_intolerance_reaction WHERE "
                     "allergy_intolerance_id = :a", **aid)
    assert not _rows(admin_engine, "SELECT 1 FROM clinical.annotation WHERE "
                     "allergy_intolerance_id = :a", **aid)
    async with session(database, clinic) as s:
        await STORE.allergy_entered_in_error(s, w.id, WHY)
        await s.commit()
    row = _rows(admin_engine, "SELECT verification_status, clinical_status FROM "
                "clinical.allergy_intolerance WHERE id = :a", **aid)[0]
    assert tuple(row) == ("entered-in-error", None)
    assert _rows(admin_engine, "SELECT reason_text FROM clinical.provenance WHERE target_id = :a",
                 **aid)[0].reason_text == "Wrong patient"
    async with session(database, clinic) as s:
        with pytest.raises(fs.InvalidTransition):
            await STORE.update_allergy(s, w.id, fs.AllergyChanges(criticality="low"),
                                       if_version=w.version + 2)


# ====================================================================== Diagnoses
async def test_diagnoses_are_ranked_and_removed_before_signing(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    _, enc = await _visit(database, clinic)

    def icd(code: str) -> fs.DiagnosisIn:
        return fs.DiagnosisIn(code=fs.Coded(system=systems.ICD10CM, code=code))

    async with session(database, clinic) as s:
        migraine = await STORE.add_encounter_diagnosis(s, enc.id, icd("G43.909"))
        await STORE.add_encounter_diagnosis(s, enc.id, icd("R51.9"))
        first = await STORE.add_encounter_diagnosis(s, enc.id, fs.DiagnosisIn(
            code=fs.Coded(system=systems.ICD10CM, code="I10"), rank=1))   # makes room
        await s.commit()
    assert (migraine.rank, first.rank) == (1, 1)
    eid = {"e": enc.id}

    def ranks() -> list[tuple[str, int]]:
        return [tuple(r) for r in _rows(
            admin_engine, "SELECT c.code_code, d.rank FROM clinical.encounter_diagnosis d JOIN "
            "clinical.condition c ON c.id = d.condition_id WHERE d.encounter_id = :e "
            "ORDER BY d.rank", **eid)]

    assert ranks() == [("I10", 1), ("G43.909", 2), ("R51.9", 3)]
    async with session(database, clinic) as s:
        await STORE.remove_encounter_diagnosis(s, enc.id, migraine.condition.id, WHY)
        await s.commit()
    assert ranks() == [("I10", 1), ("R51.9", 2)]                   # the gap closes
    cond = _rows(admin_engine, "SELECT verification_status, clinical_status FROM "
                 "clinical.condition WHERE id = :c", c=migraine.condition.id)[0]
    assert tuple(cond) == ("entered-in-error", None)              # kept, never deleted (D24)
    assert len(_rows(admin_engine, "SELECT 1 FROM clinical.provenance WHERE target_id = :c",
                     c=migraine.condition.id)) == 1
    async with session(database, clinic) as s:
        with pytest.raises(ValueError):
            await STORE.add_encounter_diagnosis(s, enc.id, fs.DiagnosisIn(
                code=fs.Coded(system=systems.ICD10CM, code="J06.9"), rank=5))


# ====================================================================== who and when
async def test_rows_record_their_author_and_provenance_the_database_time(
        database: Database, clinic: dict[str, Any], admin_engine: Engine) -> None:
    """Vimal's review of #88 (4, 5): who is an ID, not only a display name, and the Provenance's
    time is the database's, as meta_last_updated is."""
    _, enc = await _visit(database, clinic)
    async with session(database, clinic) as s:
        w = await STORE.set_encounter_status(s, enc.id, "entered-in-error", reason=WHY)
        await s.commit()
    row = _rows(admin_engine, "SELECT created_by_user_id, updated_by_user_id, meta_last_updated "
                "FROM clinical.encounter WHERE id = :e", e=enc.id)[0]
    assert (row.created_by_user_id, row.updated_by_user_id) == (clinic["user"], clinic["user"])
    prov = _rows(admin_engine, "SELECT recorded, created_by_user_id FROM clinical.provenance "
                 "WHERE target_id = :e AND target_version_id = :v", e=enc.id, v=w.version)[0]
    assert prov.created_by_user_id == clinic["user"]
    assert prov.recorded == row.meta_last_updated == w.last_updated   # one transaction's now()
