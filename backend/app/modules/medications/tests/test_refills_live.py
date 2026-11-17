"""Refill requests (#400) against a live database: the real app, core's tenant_db and portal_db,
audit, restricted-chart check and idempotency, as shri_app and shri_portal.

Until Anand's refill helpers land (#85: ``fs.RefillRequestIn``, ``create_refill_request``,
``respond_to_refill_request``, ``PrescriptionIn.prior_prescription_id``), the requests are
written here directly, as a superuser pinned to the clinic, the way the helpers are asked to
write them: intent ``proposal``, the patient as requester and subject, the prescription as
``priorPrescription``, the note as an annotation. Their ``entry_source`` is ``interface`` only to
pass ``active_requires_signature``, which the helpers' migration has to let a patient's request
through. What needs the helpers (asking from the portal, answering, the round trip to the
simulated pharmacy, Linda Thompson's refill) is skipped until they are there; meanwhile both
writes answer 503. Synthetic data only."""

# ruff: noqa: F811 (scheduling's and the seed's live fixtures are parameters here)
from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import CLINIC_A, DEV_PATIENT_CLINIC_HEADER, DEV_PATIENT_HEADER, CurrentUser
from app.db import fhir_store as fs
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.db.tests.test_seed import migrator_engine  # noqa: F401 (a fixture)
from app.modules.eligibility.tests import partner_loop as loop
from app.modules.eligibility.tests.test_eligibility_live import _in_clinic
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    setup_session,
    users,
)
from app.modules.scheduling.tests.portal_live import (  # noqa: F401 (fixtures)
    PortalChart,
    audit_rows,
    portal_app,
    portal_chart,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from ..refill_repository import helpers_ready
from .test_medications_live import API, STORE, Rx, _sign, rx  # noqa: F401 (rx: a fixture)
from .test_partner_bridge_live import _events, _signed
from .test_partner_loop_live import READS
from .test_portal_medications_live import _seed

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
NEEDS_HELPERS = pytest.mark.skipif(not helpers_ready(),
                                   reason="needs Anand's refill helpers (#85)")
M = MAPPERS
STAFF = f"{API}/refill-requests"
MINE = f"{API}/portal/me/refill-requests"
NOTE = "Down to my last week of capsules."


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _as_patient(clinic: UUID, patient: UUID) -> dict[str, str]:
    return {DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(clinic)}


def _proposal(clinic: UUID, prescription: UUID, *, status: str = "active",
              reason: str | None = None, by: UUID | None = None, note: str | None = NOTE
              ) -> UUID:
    """A refill request as the helpers are to write it (see the module docstring)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, clinic)
    try:
        prior = db.get(M["medication_request"], prescription)
        assert prior is not None
        request = M["medication_request"](
            tenant_id=clinic, status=status, intent="proposal",
            subject_patient_id=prior.subject_patient_id,
            requester_patient_id=prior.subject_patient_id, prior_prescription_id=prior.id,
            medication_codeable_concept_system=prior.medication_codeable_concept_system,
            medication_codeable_concept_code=prior.medication_codeable_concept_code,
            medication_codeable_concept_display=prior.medication_codeable_concept_display,
            entry_source="interface", updated_by_user_id=by,
            **({"status_reason_text": reason} if reason else {}))
        db.add(request)
        db.flush()
        if note:
            db.add(M["annotation"](medication_request_id=request.id, text=note,
                                   time=dt.datetime.now(dt.UTC)))
        db.commit()
        found: UUID = request.id
        return found
    finally:
        db.close()
        admin.dispose()


def _draft_of(practice: Practice, rx: Rx, prescription: UUID) -> UUID:
    """The draft an approval writes (prescription intent order with priorPrescription), in a
    later transaction than the answer, as a stand-in for the helper's."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        prior = db.get(M["medication_request"], prescription)
        assert prior is not None
        draft = M["medication_request"](
            tenant_id=practice.clinic, status="draft", intent="order",
            subject_patient_id=prior.subject_patient_id,
            requester_practitioner_id=prior.requester_practitioner_id,
            prior_prescription_id=prior.id,
            medication_codeable_concept_system=prior.medication_codeable_concept_system,
            medication_codeable_concept_code=prior.medication_codeable_concept_code,
            medication_codeable_concept_display=prior.medication_codeable_concept_display)
        db.add(draft)
        db.commit()
        found: UUID = draft.id
        return found
    finally:
        db.close()
        admin.dispose()


def _signed_at(practice: Practice, users: dict[str, CurrentUser], rx: Rx,
               facility: UUID) -> UUID:
    """A signed prescription for kaia written in a visit at ``facility``, through the store."""
    patient = practice.patients["kaia"]
    visit = _in_clinic(practice, lambda s: STORE.create_encounter(s, fs.EncounterIn(
        patient_id=patient, facility_id=facility, status="in-progress")), user=users["md"])

    async def write(s: Any) -> UUID:
        draft = await STORE.create_prescription(s, fs.PrescriptionIn(
            patient_id=patient, encounter_id=visit.id,
            medication=fs.Coded(system=systems.RXNORM, code="314076",
                                display="lisinopril 10 MG Oral Tablet"),
            dosage_text="1 tablet by mouth once daily",
            quantity=fs.DispenseQuantity(Decimal(30), "tablet"), refills=1,
            pharmacy_id=rx.pharmacy))
        await STORE.record_safety_check(s, draft.id, (), if_version=draft.version)
        await STORE.sign_prescription(s, draft.id, if_version=draft.version)
        found: UUID = draft.id
        return found
    return _in_clinic(practice, write, user=users["md"])


def _audited(practice: Practice) -> list[Any]:
    return list(_sql(practice, "SELECT patient_id, category, entity_type FROM audit.audit_event "
                     "WHERE tenant_id = :t AND category = 'phi-read' ORDER BY id",
                     t=practice.clinic))


# ------------------------------------------------------------------------- the staff list
def test_the_staff_list_reads_the_real_rows(client: Any, practice: Practice,
                                            users: dict[str, CurrentUser], rx: Rx) -> None:
    kaia = practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    elsewhere = _signed_at(practice, users, rx, practice.other_facility)  # nobody's facility
    opened = _proposal(practice.clinic, UUID(here))
    _proposal(practice.clinic, elsewhere)
    declined = _proposal(practice.clinic, UUID(here), status="cancelled", by=users["md"].id,
                         reason="Please book a visit first.")
    approved = _proposal(practice.clinic, UUID(here), status="completed", by=users["md"].id)
    draft = _draft_of(practice, rx, UUID(here))

    found = client("md").get(STAFF)
    assert found.status_code == 200, found.text
    (item,) = found.json()["items"]  # not the request whose visit is at A2
    assert (item["id"], item["status"], item["type"]) == (str(opened), "requested", "renewal")
    assert (item["patientId"], item["prescriptionId"]) == (str(kaia), here)
    assert item["patient"]["name"]["family"] == "Lindgren118" and item["restricted"] is False
    assert item["display"] == "amoxicillin 500 MG Oral Capsule"
    assert item["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    assert item["note"] == NOTE and item["requestedAt"]
    assert "respondedAt" not in item and "newPrescriptionId" not in item
    assert any(r.patient_id == kaia for r in _audited(practice))

    (no,) = client("md").get(STAFF, params={"status": "declined"}).json()["items"]
    assert (no["id"], no["declineReason"]) == (str(declined), "Please book a visit first.")
    assert no["respondedAt"] and no["respondedBy"]["displayName"] == "Avery401 Lindqvist58"
    (yes,) = client("md").get(STAFF, params={"status": "approved"}).json()["items"]
    assert (yes["id"], yes["newPrescriptionId"]) == (str(approved), str(draft))

    _sql(practice, "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i",
         i=kaia)
    (hidden,) = client("md").get(STAFF).json()["items"]
    assert hidden["restricted"] is True and hidden["patientId"] == str(kaia)
    for name in ("patient", "display", "dosageText", "note"):
        assert name not in hidden, name
    assert client("fd").get(STAFF).status_code == 403


# --------------------------------------------------------------------------- the portal list
def test_my_refill_requests_as_shri_portal(portal_app: Any, portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    clinic = portal_chart.practice.clinic
    first = _proposal(clinic, seeded["signed"])
    declined = _proposal(clinic, seeded["signed"], status="cancelled",
                         reason="Please book a visit first.")
    mine = portal_app.get(MINE, headers=_as_patient(clinic, portal_chart.a))
    assert mine.status_code == 200, mine.text
    items = mine.json()["items"]
    assert [i["id"] for i in items] == [str(declined), str(first)]  # newest first
    assert items[0]["status"] == "declined" and items[0]["respondedAt"]
    assert items[0]["declineReason"] == "Please book a visit first."
    assert items[1]["status"] == "requested" and "note" not in items[1]
    assert items[1]["display"] == "amoxicillin 500 MG Oral Capsule"
    assert items[1]["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    theirs = portal_app.get(MINE, headers=_as_patient(clinic, portal_chart.b))
    assert theirs.status_code == 200 and theirs.json()["items"] == []
    assert any(r.patient_id == portal_chart.a and r.actor_type == "patient"
               for r in audit_rows(clinic))


# ------------------------------------------------------------- the writes, until #85 lands
@pytest.mark.skipif(helpers_ready(), reason="Anand's refill helpers are merged")
def test_the_writes_are_503_until_the_helpers_land(client: Any, practice: Practice, rx: Rx,
                                                   portal_app: Any) -> None:
    here, _ = _signed(client, practice, rx)
    asked = portal_app.post(MINE, json={"prescriptionId": here},
                            headers=_as_patient(practice.clinic, practice.patients["kaia"])
                            | _key())
    assert asked.status_code == 503, asked.text
    opened = _proposal(practice.clinic, UUID(here))
    answer = client("md").post(f"{STAFF}/{opened}/respond", json={"decision": "approve"},
                               headers=_key())
    assert answer.status_code == 503, answer.text
    refused = client("rn").post(f"{STAFF}/{opened}/respond", json={"decision": "approve"},
                                headers=_key())
    assert refused.status_code == 403  # D110 before anything else
    left = _sql(practice, "SELECT status FROM clinical.medication_request "
                "WHERE intent = 'proposal' AND prior_prescription_id = :p", p=here)
    assert [r.status for r in left] == ["active"]


# --------------------------------------------------------------- with Anand's helpers (#85)
@NEEDS_HELPERS
def test_a_patient_asks_once_per_key_and_once_per_prescription(
        client: Any, practice: Practice, rx: Rx, portal_app: Any) -> None:
    kaia = practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    headers = _as_patient(practice.clinic, kaia) | _key()
    body = {"prescriptionId": here, "note": NOTE}
    asked = portal_app.post(MINE, json=body, headers=headers)
    assert asked.status_code == 201, asked.text
    assert asked.headers["Location"] == MINE
    again = portal_app.post(MINE, json=body, headers=headers)  # the same key: the same answer
    assert again.status_code == 201 and again.json()["id"] == asked.json()["id"]
    other = portal_app.post(MINE, json=body, headers=_as_patient(practice.clinic, kaia) | _key())
    assert other.status_code == 409
    assert other.json()["errors"][0]["code"] == "refill-already-requested"
    events = _sql(practice, "SELECT type, patient_id, data FROM admin.event_log "
                  "WHERE subject = :s", s=f"refill-request/{asked.json()['id']}")
    assert [(e.type, e.patient_id, e.data["status"]) for e in events] == [
        ("refill-request.received", kaia, "requested")]
    listed = client("md").get(STAFF).json()["items"]
    assert [(i["id"], i["note"]) for i in listed] == [(asked.json()["id"], NOTE)]


@NEEDS_HELPERS
async def test_approve_then_check_sign_and_send_to_the_simulated_pharmacy(
        client: Any, practice: Practice, rx: Rx, portal_app: Any) -> None:
    loop.require_worker_grants(*READS)
    _sql(practice, "UPDATE admin.integration_endpoint SET adapter = 'simulated-erx' "
         "WHERE tenant_id = :t AND kind = 'erx'", t=practice.clinic)
    kaia = practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    asked = portal_app.post(MINE, json={"prescriptionId": here},
                            headers=_as_patient(practice.clinic, kaia) | _key())
    assert asked.status_code == 201, asked.text
    approved = client("md").post(f"{STAFF}/{asked.json()['id']}/respond",
                                 json={"decision": "approve"}, headers=_key())
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"
    new_id = approved.json()["newPrescriptionId"]
    draft = client("md").get(f"{API}/prescriptions/{new_id}").json()
    assert draft["status"] == "draft" and draft["refills"] == 0 and draft["quantity"]
    assert client("md").post(f"{API}/prescriptions/{new_id}/safety-check").status_code == 200
    assert _sign(client, new_id, '"1"').status_code == 200
    (message_id,) = [r.id for r in _sql(
        practice, "SELECT id FROM admin.integration_message WHERE payload->>'prescriptionId' = :r",
        r=new_id)]
    async for hooks in loop.hook_app():
        await loop.deliver(hooks, "erx", "simulated-erx", message_id, delay=0.5)
    assert _events(practice, new_id) == ["queued", "sent", "accepted"]
    again = client("md").post(f"{STAFF}/{asked.json()['id']}/respond",
                              json={"decision": "decline", "reason": "Too late."},
                              headers=_key())
    assert again.status_code == 409 and again.json()["currentState"] == "approved"


@NEEDS_HELPERS
def test_linda_thompsons_omeprazole_is_refill_ready(migrator_engine: Engine, portal_app: Any,
                                                    monkeypatch: pytest.MonkeyPatch) -> None:
    from app.db.tests.test_seed_linda import LINDA, _seeded  # the demo seed, as its test runs it

    _seeded(migrator_engine, monkeypatch)
    (omeprazole,) = [r.id for r in _sql_in(CLINIC_A, (
        "SELECT id FROM clinical.medication_request WHERE subject_patient_id = :p "
        "AND intent = 'order' AND medication_codeable_concept_code = '198051'"), p=LINDA)]
    asked = portal_app.post(MINE, json={"prescriptionId": str(omeprazole)},
                            headers=_as_patient(CLINIC_A, LINDA) | _key())
    assert asked.status_code == 201, asked.text
    assert asked.json()["display"].lower().startswith("omeprazole 20")


def _sql_in(clinic: UUID, sql: str, **params: Any) -> Any:
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, clinic)
    try:
        return db.execute(text(sql), params).all()
    finally:
        db.close()
        admin.dispose()
