"""The patient portal's own medication list (listPortalMedications) against a live database: the
real app with the portal as ``shri_portal`` and the patient development sign-in (X-Dev-Patient,
D108). Records are written through Anand's helpers as ``shri_app``, by a clinician linked to a
practitioner, as the prescribing flow writes them. Synthetic data only."""

from __future__ import annotations

import asyncio
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
from app.db.models import MAPPERS
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url
from app.modules.scheduling.tests.conftest import setup_session
from app.modules.scheduling.tests.portal_live import PortalChart, audit_rows, portal_client

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/portal/me/medications"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
M = MAPPERS


def _prescriber(chart: PortalChart) -> uuid.UUID:
    """A clinician user linked to a practitioner with a name (synthetic)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, chart.practice.clinic)
    try:
        doctor = M["practitioner"](tenant_id=chart.practice.clinic)
        doctor.name = [M["human_name"](family="Lindqvist58", given=["Avery401"], prefix=["Dr."],
                                       use="official")]
        db.add(doctor)
        db.flush()
        user = uuid.uuid4()
        db.execute(text("INSERT INTO admin.app_user (id, tenant_id, keycloak_subject, username, "
                        "display_name, practitioner_id) VALUES (:i, :t, :s, :u, "
                        "'Test prescriber (synthetic)', :p)"),
                   {"i": user, "t": chart.practice.clinic, "s": str(uuid.uuid4()),
                    "u": f"rx.{user.hex[:8]}", "p": doctor.id})
        db.commit()
        return user
    finally:
        db.close()
        admin.dispose()


def _pharmacy() -> uuid.UUID:
    pharmacy = uuid.uuid4()
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.begin() as c:
            c.execute(text("INSERT INTO admin.pharmacy (id, ncpdp_id, npi, name, is_mail_order, "
                           "is_active) VALUES (:i, :n, '1245319599', 'Test Pharmacy (synthetic)', "
                           "false, true)"), {"i": pharmacy, "n": f"{uuid.uuid4().int % 10**7:07d}"})
        return pharmacy
    finally:
        admin.dispose()


async def _write(chart: PortalChart, user: uuid.UUID, patient: uuid.UUID,
                 pharmacy: uuid.UUID) -> dict[str, uuid.UUID]:
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_app")
    store = fs.SqlFhirStore()
    amoxicillin = fs.Coded(system=RXNORM, code="308182",
                           display="amoxicillin 500 MG Oral Capsule")
    try:
        async with database.tenant_session(chart.practice.clinic, user) as db:
            reported = await store.record_medication(db, fs.MedicationIn(
                patient_id=patient, medication=fs.Coded(system=RXNORM, code="314076",
                                                        display="lisinopril 10 MG Oral Tablet"),
                dosage_text="1 tablet by mouth daily"))
            stopped = await store.record_medication(db, fs.MedicationIn(
                patient_id=patient, medication=fs.Coded(system=RXNORM, code="197361",
                                                        display="amlodipine 5 MG Oral Tablet"),
                dosage_text="1 tablet by mouth daily", status="stopped"))
            signed = await store.create_prescription(db, fs.PrescriptionIn(
                patient_id=patient, medication=amoxicillin,
                dosage_text="1 capsule by mouth three times daily for 10 days",
                quantity=fs.DispenseQuantity(Decimal("30"), "capsule"), days_supply=10,
                refills=0, pharmacy_id=pharmacy))
            await store.record_safety_check(db, signed.id, (), if_version=signed.version)
            await store.sign_prescription(db, signed.id, if_version=signed.version)
            draft = await store.create_prescription(db, fs.PrescriptionIn(
                patient_id=patient, medication=amoxicillin, dosage_text="draft"))
            wrong = await store.create_prescription(db, fs.PrescriptionIn(
                patient_id=patient, medication=amoxicillin,
                dosage_text="1 capsule by mouth twice daily",
                quantity=fs.DispenseQuantity(Decimal("20"), "capsule"), pharmacy_id=pharmacy))
            # Only a draft can be entered-in-error (a signed one is cancelled, later).
            await store.prescription_entered_in_error(db, wrong.id, fs.Reason(text="Wrong chart."))
            await db.commit()
    finally:
        await database.dispose()
    return {"reported": reported.id, "stopped": stopped.id, "signed": signed.id,
            "draft": draft.id, "wrong": wrong.id}


def _seed(chart: PortalChart) -> dict[str, uuid.UUID]:
    return asyncio.run(_write(chart, _prescriber(chart), chart.a, _pharmacy()))


def test_my_medications_active_first_with_the_prescriber(portal_app: Any,
                                                        portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    found = me.get(API)
    assert found.status_code == 200, found.text
    items = found.json()["items"]
    # The signed prescription and the reported one, active first; the stopped one last; never
    # the draft or the entered-in-error prescription.
    assert {i["id"] for i in items} == {str(seeded[k]) for k in ("reported", "stopped", "signed")}
    assert [i["status"] for i in items] == ["active", "active", "stopped"]
    rx = next(i for i in items if i["id"] == str(seeded["signed"]))
    assert rx["source"] == "prescription" and rx["display"] == "amoxicillin 500 MG Oral Capsule"
    assert rx["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    assert rx["prescriberDisplayName"] == "Dr. Avery401 Lindqvist58" and rx["prescribedAt"]
    own = next(i for i in items if i["id"] == str(seeded["reported"]))
    assert own["source"] == "reported" and own["status"] == "active"
    assert "prescribedAt" not in own and "prescriberDisplayName" not in own
    page = me.get(API, params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["nextCursor"]
    rest = me.get(API, params={"limit": 2, "cursor": page["nextCursor"]}).json()
    assert [i["id"] for i in rest["items"]] == [str(seeded["stopped"])] and "nextCursor" not in rest
    rows = audit_rows(portal_chart.practice.clinic)
    assert any(r.patient_id == portal_chart.a and r.category == "phi-read"
               and r.actor_type == "patient" for r in rows)


def test_another_patients_medications_do_not_exist(portal_app: Any,
                                                   portal_chart: PortalChart) -> None:
    _seed(portal_chart)
    other = portal_client(portal_app, portal_chart, portal_chart.b)
    listed = other.get(API)
    assert listed.status_code == 200 and listed.json()["items"] == []


def test_bad_parameters_and_no_patient_session(portal_app: Any,
                                               portal_chart: PortalChart) -> None:
    me = portal_client(portal_app, portal_chart, portal_chart.a)
    for params in ({"limit": 0}, {"limit": 101}):
        assert me.get(API, params=params).status_code == 422, params
    assert me.get(API, params={"cursor": "bm90LWFuLW9mZnNldA"}).status_code == 400
    refused = portal_app.get(API, headers={"X-Dev-User": "md"})  # a staff session isn't a patient's
    assert refused.status_code in (401, 403), refused.status_code
