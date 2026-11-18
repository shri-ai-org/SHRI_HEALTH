"""Refill requests (#400) against a live database: the real app, core's tenant_db and portal_db,
audit, restricted-chart check and idempotency, as shri_app and shri_portal, through Anand's
helpers (#424, migration 0028): the portal's request (once per key, once per open request, no
note, nothing controlled), the staff list, the answer (decline codes and their words; approve,
then the safety check, sign-and-send and the simulated pharmacy) and Linda Thompson's omeprazole
from the demo seed. The portal list's set-up writes its requests directly, as a superuser pinned
to the clinic, the way the helper writes them. Synthetic data only."""

# ruff: noqa: F811 (scheduling's and the seed's live fixtures are parameters here)
from __future__ import annotations

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

from .test_medications_live import API, STORE, Rx, _sign, rx  # noqa: F401 (rx: a fixture)
from .test_partner_bridge_live import _events, _signed
from .test_partner_loop_live import READS
from .test_portal_medications_live import _seed

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = MAPPERS
STAFF = f"{API}/refill-requests"
MINE = f"{API}/portal/me/refill-requests"
VISIT = "needs-visit"  # a decline reason code; the patient reads fs.REFILL_DECLINE_REASONS[VISIT]
#: A synthetic Schedule IV product (its RxNorm concept carries dea_schedule).
DIAZEPAM = fs.Coded(system=systems.RXNORM, code="197591", display="diazepam 5 MG Oral Tablet")


def _portal_may_publish() -> bool:
    """``shri_portal`` may write ``refill-request.received``: 0021's RESTRICTIVE policy
    ``portal_own_event`` on ``admin.event_log`` allows the appointment events only, and #424's
    0028 doesn't add this one (asked of Anand). Until it does, asking from the portal answers
    500 here, so the tests that ask successfully wait for it."""
    if not TEST_DATABASE_URL:
        return False
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.connect() as c:
            check = c.execute(text(
                "SELECT with_check FROM pg_policies WHERE schemaname = 'admin' "
                "AND tablename = 'event_log' AND policyname = 'portal_own_event'")).scalar()
    finally:
        admin.dispose()
    return check is None or "refill-request.received" in check


@pytest.fixture
def portal_publishes() -> None:
    if not _portal_may_publish():
        pytest.skip("needs refill-request.received in admin.event_log's portal_own_event "
                    "policy (Anand, #424)")


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _as_patient(clinic: UUID, patient: UUID) -> dict[str, str]:
    return {DEV_PATIENT_HEADER: str(patient), DEV_PATIENT_CLINIC_HEADER: str(clinic)}


def _proposal(clinic: UUID, prescription: UUID, *, status: str = "active",
              reason: str | None = None) -> UUID:
    """A refill request as the helpers write it: no note; a decline with its code and words."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, clinic)
    try:
        prior = db.get(M["medication_request"], prescription)
        assert prior is not None
        declined = ({"status_reason_system": systems.SHRI_LOCAL, "status_reason_code": reason,
                     "status_reason_text": fs.REFILL_DECLINE_REASONS[reason]} if reason else {})
        request = M["medication_request"](
            tenant_id=clinic, status=status, intent="proposal",
            subject_patient_id=prior.subject_patient_id,
            requester_patient_id=prior.subject_patient_id, prior_prescription_id=prior.id,
            medication_codeable_concept_system=prior.medication_codeable_concept_system,
            medication_codeable_concept_code=prior.medication_codeable_concept_code,
            medication_codeable_concept_display=prior.medication_codeable_concept_display,
            entry_source="patient-reported", **declined)
        db.add(request)
        db.commit()
        found: UUID = request.id
        return found
    finally:
        db.close()
        admin.dispose()


def _ask(portal_app: Any, clinic: UUID, patient: UUID, prescription: str | UUID,
         headers: dict[str, str] | None = None, **body: Any) -> Any:
    return portal_app.post(MINE, json={"prescriptionId": str(prescription), **body},
                           headers=_as_patient(clinic, patient) | (headers or _key()))


def _respond(client: Any, request_id: str, user: str = "md", **body: Any) -> Any:
    return client(user).post(f"{STAFF}/{request_id}/respond", json=body, headers=_key())


def _signed_at(practice: Practice, users: dict[str, CurrentUser], rx: Rx, facility: UUID, *,
               medication: fs.Coded | None = None, dea_schedule: str | None = None) -> UUID:
    """A signed prescription for kaia written in a visit at ``facility``, through the store
    (lisinopril unless ``medication`` says otherwise)."""
    patient = practice.patients["kaia"]
    visit = _in_clinic(practice, lambda s: STORE.create_encounter(s, fs.EncounterIn(
        patient_id=patient, facility_id=facility, status="in-progress")), user=users["md"])

    async def write(s: Any) -> UUID:
        draft = await STORE.create_prescription(s, fs.PrescriptionIn(
            patient_id=patient, encounter_id=visit.id,
            medication=medication or fs.Coded(system=systems.RXNORM, code="314076",
                                              display="lisinopril 10 MG Oral Tablet"),
            dosage_text="1 tablet by mouth once daily",
            quantity=fs.DispenseQuantity(Decimal(30), "tablet"), refills=1,
            pharmacy_id=rx.pharmacy, dea_schedule=dea_schedule))
        await STORE.record_safety_check(s, draft.id, (), if_version=draft.version)
        await STORE.sign_prescription(s, draft.id, if_version=draft.version)
        found: UUID = draft.id
        return found
    return _in_clinic(practice, write, user=users["md"])


def _concept(drug: fs.Coded, schedule: str | None = None) -> None:
    """``drug``'s RxNorm row, with its DEA schedule if any (synthetic terminology, as
    test_medications_live's): the database refuses a refill whose concept isn't loaded."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        system = c.execute(text("SELECT id FROM admin.code_system WHERE uri = :u"),
                           {"u": systems.RXNORM}).scalar_one()
        concept = c.execute(text(
            "INSERT INTO admin.concept (id, code_system_id, code, display, is_active) "
            "VALUES (gen_random_uuid(), :s, :c, :d, true) ON CONFLICT (code_system_id, code) "
            "DO UPDATE SET is_active = true RETURNING id"),
            {"s": system, "c": drug.code, "d": drug.display}).scalar_one()
        if schedule is not None:
            c.execute(text("INSERT INTO admin.concept_property (id, concept_id, property, value) "
                           "VALUES (gen_random_uuid(), :c, 'dea_schedule', :v) "
                           "ON CONFLICT DO NOTHING"), {"c": concept, "v": schedule})
    admin.dispose()


def _audited(practice: Practice) -> list[Any]:
    return list(_sql(practice, "SELECT patient_id, category, entity_type FROM audit.audit_event "
                     "WHERE tenant_id = :t AND category = 'phi-read' ORDER BY id",
                     t=practice.clinic))


# ------------------------------------------------------------------------- the staff list
def test_the_staff_list_reads_the_real_rows(client: Any, practice: Practice,
                                            users: dict[str, CurrentUser], rx: Rx,
                                            portal_app: Any, portal_publishes: None) -> None:
    clinic, kaia = practice.clinic, practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    elsewhere = _signed_at(practice, users, rx, practice.other_facility)  # nobody's facility
    declined = _ask(portal_app, clinic, kaia, here).json()["id"]
    assert _respond(client, declined, decision="decline", reason=VISIT).status_code == 200
    approved = _ask(portal_app, clinic, kaia, here).json()["id"]
    answer = _respond(client, approved, decision="approve")
    assert answer.status_code == 200, answer.text
    draft = answer.json()["newPrescriptionId"]
    opened = _ask(portal_app, clinic, kaia, here).json()["id"]
    assert _ask(portal_app, clinic, kaia, elsewhere).status_code == 201

    found = client("md").get(STAFF)
    assert found.status_code == 200, found.text
    (item,) = found.json()["items"]  # not the request whose visit is at A2
    assert (item["id"], item["status"], item["type"]) == (opened, "requested", "renewal")
    assert (item["patientId"], item["prescriptionId"]) == (str(kaia), here)
    assert item["patient"]["name"]["family"] == "Lindgren118" and item["restricted"] is False
    assert item["display"] == "amoxicillin 500 MG Oral Capsule"
    assert item["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    assert item["requestedAt"] and "note" not in item
    assert "respondedAt" not in item and "newPrescriptionId" not in item
    assert any(r.patient_id == kaia for r in _audited(practice))

    (no,) = client("md").get(STAFF, params={"status": "declined"}).json()["items"]
    assert (no["id"], no["declineReason"]) == (declined, fs.REFILL_DECLINE_REASONS[VISIT])
    assert no["respondedAt"] and no["respondedBy"]["displayName"] == "Avery401 Lindqvist58"
    (yes,) = client("md").get(STAFF, params={"status": "approved"}).json()["items"]
    assert (yes["id"], yes["newPrescriptionId"]) == (approved, draft)
    assert "declineReason" not in yes

    _sql(practice, "UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :i",
         i=kaia)
    (hidden,) = client("md").get(STAFF).json()["items"]
    assert hidden["restricted"] is True and hidden["patientId"] == str(kaia)
    for name in ("patient", "display", "dosageText"):
        assert name not in hidden, name
    assert client("fd").get(STAFF).status_code == 403


# --------------------------------------------------------------------------- the portal list
def test_my_refill_requests_as_shri_portal(portal_app: Any, portal_chart: PortalChart) -> None:
    seeded = _seed(portal_chart)
    clinic = portal_chart.practice.clinic
    first = _proposal(clinic, seeded["signed"])
    declined = _proposal(clinic, seeded["signed"], status="cancelled", reason=VISIT)
    mine = portal_app.get(MINE, headers=_as_patient(clinic, portal_chart.a))
    assert mine.status_code == 200, mine.text
    items = mine.json()["items"]
    assert [i["id"] for i in items] == [str(declined), str(first)]  # newest first
    assert items[0]["status"] == "declined" and items[0]["respondedAt"]
    assert items[0]["declineReason"] == fs.REFILL_DECLINE_REASONS[VISIT]
    assert items[1]["status"] == "requested" and "note" not in items[1]
    assert items[1]["display"] == "amoxicillin 500 MG Oral Capsule"
    assert items[1]["dosageText"] == "1 capsule by mouth three times daily for 10 days"
    theirs = portal_app.get(MINE, headers=_as_patient(clinic, portal_chart.b))
    assert theirs.status_code == 200 and theirs.json()["items"] == []
    assert any(r.patient_id == portal_chart.a and r.actor_type == "patient"
               for r in audit_rows(clinic))


# ------------------------------------------------------------------ the portal's request
def test_a_patient_asks_once_per_key_and_once_per_prescription(
        client: Any, practice: Practice, rx: Rx, portal_app: Any, portal_publishes: None) -> None:
    clinic, kaia = practice.clinic, practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    headers = _key()
    asked = _ask(portal_app, clinic, kaia, here, headers)
    assert asked.status_code == 201, asked.text
    assert asked.headers["Location"] == MINE
    again = _ask(portal_app, clinic, kaia, here, headers)  # the same key: the same answer
    assert again.status_code == 201 and again.json()["id"] == asked.json()["id"]
    other = _ask(portal_app, clinic, kaia, here)  # a second key: one open request already
    assert other.status_code == 409 and other.json()["code"] == "invalid-state-transition"
    assert [(e["pointer"], e["code"]) for e in other.json()["errors"]] == [
        ("/prescriptionId", "refill-already-requested")]
    events = _sql(practice, "SELECT type, patient_id, data FROM admin.event_log "
                  "WHERE subject = :s", s=f"refill-request/{asked.json()['id']}")
    assert [(e.type, e.patient_id, e.data["status"]) for e in events] == [
        ("refill-request.received", kaia, "requested")]
    listed = client("md").get(STAFF).json()["items"]
    assert [i["id"] for i in listed] == [asked.json()["id"]] and "note" not in listed[0]


def test_asking_refuses_a_note_and_a_controlled_substance(
        client: Any, practice: Practice, users: dict[str, CurrentUser], rx: Rx,
        portal_app: Any) -> None:
    clinic, kaia = practice.clinic, practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    noted = _ask(portal_app, clinic, kaia, here, note="Down to my last week of capsules.")
    assert noted.status_code == 422 and noted.json()["code"] == "validation-failed"
    assert [(e["pointer"], e["code"]) for e in noted.json()["errors"]] == [
        ("/note", "not-allowed-value")]

    _concept(DIAZEPAM, "CIV")
    for schedule in ("CIV", None):  # on the prescription, or only on its RxNorm concept (0028)
        controlled = _signed_at(practice, users, rx, practice.facility, medication=DIAZEPAM,
                                dea_schedule=schedule)
        refused = _ask(portal_app, clinic, kaia, controlled)
        assert refused.status_code == 409, refused.text
        assert refused.json()["code"] == "invalid-state-transition"
        assert [(e["pointer"], e["code"]) for e in refused.json()["errors"]] == [
            ("/prescriptionId", "not-refillable")]
    left = _sql(practice, "SELECT count(*) FROM clinical.medication_request "
                "WHERE tenant_id = :t AND intent = 'proposal'", t=clinic)
    assert left[0][0] == 0


# ------------------------------------------------------------------------------- the answer
def test_declining_takes_a_listed_code_and_shows_its_words(
        client: Any, practice: Practice, rx: Rx, portal_app: Any, portal_publishes: None) -> None:
    clinic, kaia = practice.clinic, practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    request_id = _ask(portal_app, clinic, kaia, here).json()["id"]
    for user in ("rn", "fd"):  # D110, and FD holds no refill permission
        refused = _respond(client, request_id, user=user, decision="decline", reason=VISIT)
        assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"
    unknown = _respond(client, request_id, decision="decline", reason="Please come in.")
    assert unknown.status_code == 422 and unknown.json()["code"] == "validation-failed"
    assert [(e["pointer"], e["code"]) for e in unknown.json()["errors"]] == [
        ("/reason", "not-allowed-value")]
    declined = _respond(client, request_id, user="md", decision="decline", reason=VISIT)
    assert declined.status_code == 200, declined.text
    words = fs.REFILL_DECLINE_REASONS[VISIT]
    assert (declined.json()["status"], declined.json()["declineReason"]) == ("declined", words)
    (mine,) = portal_app.get(MINE, headers=_as_patient(clinic, kaia)).json()["items"]
    assert (mine["status"], mine["declineReason"]) == ("declined", words)
    stored = _sql(practice, "SELECT status, status_reason_code FROM clinical.medication_request "
                  "WHERE id = :i", i=request_id)
    assert [(r.status, r.status_reason_code) for r in stored] == [("cancelled", VISIT)]


async def test_approve_then_check_sign_and_send_to_the_simulated_pharmacy(
        client: Any, practice: Practice, rx: Rx, portal_app: Any, portal_publishes: None) -> None:
    loop.require_worker_grants(*READS)
    _sql(practice, "UPDATE admin.integration_endpoint SET adapter = 'simulated-erx' "
         "WHERE tenant_id = :t AND kind = 'erx'", t=practice.clinic)
    kaia = practice.patients["kaia"]
    here, _ = _signed(client, practice, rx)
    asked = _ask(portal_app, practice.clinic, kaia, here)
    assert asked.status_code == 201, asked.text
    approved = _respond(client, asked.json()["id"], decision="approve")
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"
    new_id = approved.json()["newPrescriptionId"]
    stored = _sql(practice, "SELECT prior_prescription_id FROM clinical.medication_request "
                  "WHERE id = :i", i=new_id)
    assert [str(r.prior_prescription_id) for r in stored] == [here]
    draft = client("md").get(f"{API}/prescriptions/{new_id}").json()
    assert draft["status"] == "draft" and draft["refills"] == 0 and draft["quantity"]
    checked = client("md").post(f"{API}/prescriptions/{new_id}/safety-check")
    assert checked.status_code == 200, checked.text
    # The same ingredient as the original, which the renewal replaces: no duplicate warning.
    assert "duplicate-medication" not in {a["kind"] for a in checked.json()["alerts"]}
    assert _sign(client, new_id, '"1"').status_code == 200
    (message_id,) = [r.id for r in _sql(
        practice, "SELECT id FROM admin.integration_message WHERE payload->>'prescriptionId' = :r",
        r=new_id)]
    async for hooks in loop.hook_app():
        await loop.deliver(hooks, "erx", "simulated-erx", message_id, delay=0.5)
    assert _events(practice, new_id) == ["queued", "sent", "accepted"]
    again = _respond(client, asked.json()["id"], decision="decline", reason=VISIT)
    assert again.status_code == 409 and again.json()["currentState"] == "approved"


def test_linda_thompsons_omeprazole_is_refill_ready(migrator_engine: Engine, portal_app: Any,
                                                    monkeypatch: pytest.MonkeyPatch,
                                                    portal_publishes: None) -> None:
    from app.db.tests.test_seed_linda import LINDA, _seeded  # the demo seed, as its test runs it

    _seeded(migrator_engine, monkeypatch)
    # The demo server loads RxNorm; here only her omeprazole's row (no DEA schedule).
    _concept(fs.Coded(system=systems.RXNORM, code="198051",
                      display="omeprazole 20 MG Delayed Release Oral Capsule"))
    (omeprazole,) = [r.id for r in _sql_in(CLINIC_A, (
        "SELECT id FROM clinical.medication_request WHERE subject_patient_id = :p "
        "AND intent = 'order' AND medication_codeable_concept_code = '198051'"), p=LINDA)]
    asked = _ask(portal_app, CLINIC_A, LINDA, omeprazole)
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
