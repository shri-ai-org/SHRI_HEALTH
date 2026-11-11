"""Problems, family, social and surgical history for a live test's patient, written through
Anand's helpers (``app.db.fhir_store``) as the given user in the practice's clinic, as the
demo seed writes them (#278). The API has no writes for these yet (after the demo). Synthetic
data only."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass

from pydantic import SecretStr

from app.core.config import Settings
from app.core.db import Database
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role

ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
SNOMED = "http://snomed.info/sct"
ROLE_CODE = "http://terminology.hl7.org/CodeSystem/v3-RoleCode"
HYPERTENSION = fs.Coded(system=ICD10, code="I10", display="Essential (primary) hypertension")
ASTHMA = fs.Coded(system=ICD10, code="J45.909", display="Unspecified asthma, uncomplicated")
TOBACCO = fs.Coded(system=systems.LOINC, code="72166-2", display="Tobacco smoking status")
NEVER_SMOKED = fs.Coded(system=SNOMED, code="266919005", display="Never smoked tobacco")
APPENDECTOMY = fs.Coded(system=SNOMED, code="80146002", display="Appendectomy")


@dataclass(frozen=True)
class Seeded:
    problem: uuid.UUID
    asthma: uuid.UUID  # marked entered-in-error
    family: uuid.UUID
    social: uuid.UUID
    surgical: uuid.UUID


async def _write(tenant: uuid.UUID, user: uuid.UUID, patient: uuid.UUID) -> Seeded:
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_app")
    store = fs.SqlFhirStore()
    try:
        async with database.tenant_session(tenant, user) as db:
            problem = await store.create_problem(db, fs.ProblemIn(
                patient_id=patient, code=HYPERTENSION, onset="2019-04",
                note="Home readings reviewed."))
            asthma = await store.create_problem(db, fs.ProblemIn(
                patient_id=patient, code=ASTHMA, onset="2004"))
            await store.problem_entered_in_error(
                db, asthma.id, fs.Reason(text="Recorded on the wrong chart."))
            family = await store.create_family_history(db, fs.FamilyHistoryIn(
                patient_id=patient, relationship=fs.Coded(system=ROLE_CODE, code="MTH",
                                                          display="mother"),
                sex="female", deceased=False, note="Reported by the patient.",
                conditions=(fs.FamilyConditionIn(code=HYPERTENSION, onset_age=52),)))
            social = await store.record_social_history(db, fs.SocialHistoryIn(
                patient_id=patient, code=TOBACCO, value=NEVER_SMOKED, effective="2026-01-15"))
            surgical = await store.create_surgical_history(db, fs.SurgicalHistoryIn(
                patient_id=patient, code=APPENDECTOMY, performed="1998",
                body_site=fs.Coded(system=SNOMED, code="66754008", display="Appendix"),
                note="No complications."))
            await db.commit()
    finally:
        await database.dispose()
    return Seeded(problem.id, asthma.id, family.id, social.id, surgical.id)


def seed_history(tenant: uuid.UUID, user: uuid.UUID, patient: uuid.UUID) -> Seeded:
    return asyncio.run(_write(tenant, user, patient))
