"""The medication list and prescriptions against a live database, as shri_app, with nothing
replaced but the sign-in: core's tenant_db, idempotency, audit, restricted-chart check, outbox
(enqueue) and events, and Anand's write helpers. The practice, users and client are scheduling's
live fixtures (a fresh clinic A with a facility, a provider and synthetic patients, and a clinic
B); here the md user is linked to a practitioner with an NPI, the platform directory gets a
pharmacy, the clinic an e-prescribing connection, and the terminology a few synthetic RxNorm
rows (the real release is loaded by ``app.db.terminology``, not in tests).

The NewRx is built from the real tables and checked against its JSON Schema, and the recorded
synthetic replies (contracts/partners/pharmacy/examples/) are filed through ``record_status`` in a
clinic session, as the /hooks/erx receiver will. Synthetic data only.
"""

# ruff: noqa: F811 (scheduling's live fixtures are parameters here)
from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.core.deps import DEV_USERS, CurrentUser
from app.core.errors import NotFound, ValidationFailed
from app.db import fhir_store as fs
from app.db.models import MAPPERS, systems
from app.db.tests import builders as b
from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.eligibility.tests.schema_check import errors
from app.modules.eligibility.tests.test_eligibility_live import _in_clinic
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    setup_session,
    users,
)
from app.modules.scheduling.tests.test_check_in_live import _sql

from .. import service
from .test_messages import NEW_RX, example

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
API = "/api/v1"
M = MAPPERS
STORE = fs.SqlFhirStore()
RX = systems.RXNORM
AMOXICILLIN = {"codings": [{"system": RX, "code": "308191",
                            "display": "amoxicillin 500 MG Oral Capsule"}]}
#: Synthetic RxNorm rows: two products with their ingredient, and the ingredients.
CONCEPTS = (("308191", "amoxicillin 500 MG Oral Capsule", ("723",)),
            ("314076", "lisinopril 10 MG Oral Tablet", ("29046",)),
            ("723", "amoxicillin", ()), ("29046", "lisinopril", ()))


@dataclass(frozen=True)
class Rx:
    pharmacy: UUID
    encounter: str
    md: CurrentUser


def _terminology() -> None:
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        system = c.execute(text("SELECT id FROM admin.code_system WHERE uri = :u"),
                           {"u": RX}).scalar_one()
        for code, display, ingredients in CONCEPTS:
            concept = c.execute(text(
                "INSERT INTO admin.concept (id, code_system_id, code, display, is_active) "
                "VALUES (gen_random_uuid(), :s, :c, :d, true) ON CONFLICT (code_system_id, code) "
                "DO UPDATE SET is_active = true RETURNING id"),
                {"s": system, "c": code, "d": display}).scalar_one()
            for value in ingredients:
                c.execute(text(
                    "INSERT INTO admin.concept_property (id, concept_id, property, value) VALUES "
                    "(gen_random_uuid(), :c, 'ingredient', :v) ON CONFLICT DO NOTHING"),
                    {"c": concept, "v": value})
    admin.dispose()


@pytest.fixture
def rx(practice: Practice, users: dict[str, CurrentUser]) -> Rx:
    _terminology()
    pharmacy = uuid.uuid4()
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        c.execute(text("INSERT INTO admin.pharmacy (id, ncpdp_id, npi, name, is_mail_order, "
                       "is_active) VALUES (:i, :n, '1245319599', 'Test Pharmacy (synthetic)', "
                       "false, true)"), {"i": pharmacy, "n": f"{uuid.uuid4().int % 10**7:07d}"})
        c.execute(text(
            "INSERT INTO admin.integration_endpoint (id, tenant_id, kind, adapter, name, "
            "environment, baa_on_file, is_active) VALUES (gen_random_uuid(), :t, 'erx', "
            "'simulated', 'Simulated pharmacy', 'test', false, true)"), {"t": practice.clinic})
    db = setup_session(admin, practice.clinic)
    try:  # the md user prescribes: a practitioner with an NPI and a name
        doctor = M["practitioner"](tenant_id=practice.clinic)
        doctor.identifier = [M["identifier"](system=systems.NPI, value=b.npi(), use="official")]
        doctor.name = [M["human_name"](family="Lindqvist58", given=["Avery401"], use="official")]
        db.add(doctor)
        db.flush()
        db.execute(text("UPDATE admin.app_user SET practitioner_id = :p WHERE id = :u"),
                   {"p": doctor.id, "u": users["md"].id})
        db.commit()
    finally:
        db.close()
        admin.dispose()
    visit = _in_clinic(practice, lambda s: STORE.create_encounter(s, fs.EncounterIn(
        patient_id=practice.patients["kaia"], facility_id=practice.facility,
        status="in-progress")), user=users["md"])
    return Rx(pharmacy, str(visit.id), users["md"])


def _key() -> dict[str, str]:
    return {"Idempotency-Key": str(uuid.uuid4())}


def _draft(client: Any, practice: Practice, rx: Rx, **extra: Any) -> Any:
    body = {"patientId": str(practice.patients["kaia"]), "encounterId": rx.encounter,
            "medication": AMOXICILLIN,
            "dosageText": "1 capsule by mouth three times daily for 10 days",
            "quantity": {"value": 30, "unit": "capsule"}, "daysSupply": 10, "refills": 0,
            "substitutionAllowed": True, "pharmacyId": str(rx.pharmacy),
            "noteToPharmacy": "Synthetic test prescription.", **extra}
    return client("md").post(f"{API}/prescriptions", json=body, headers=_key())


def _allergy(practice: Practice, rx: Rx, code: str = "723") -> UUID:
    written = _in_clinic(practice, lambda s: STORE.create_allergy(s, fs.AllergyIn(
        patient_id=practice.patients["kaia"], categories=("medication",),
        code=fs.Coded(system=RX, code=code, display="amoxicillin"))), user=rx.md)
    return written.id


def _sign(client: Any, rx_id: str, etag: str, key: dict[str, str] | None = None) -> Any:
    return client("md").post(f"{API}/prescriptions/{rx_id}/sign-and-send",
                             headers={"If-Match": etag, **(key or _key())})


def _audited(practice: Practice, category: str) -> list[Any]:
    found: list[Any] = _sql(practice, "SELECT patient_id FROM audit.audit_event "
                            "WHERE tenant_id = :t AND category = :c", t=practice.clinic,
                            c=category)
    return found


# ------------------------------------------------------------------------------- the list
def test_the_list_records_and_reads_reported_medications(
        client: Any, practice: Practice, rx: Rx,
        users: dict[str, CurrentUser]) -> None:
    kaia = practice.patients["kaia"]
    url = f"{API}/patients/{kaia}/medications"
    recorded = client("ma").post(url, json={
        "medication": {"codings": [{"system": RX, "code": "314076",
                                    "display": "lisinopril 10 MG Oral Tablet"}]},
        "dosageText": "1 tablet by mouth once daily", "note": "Reported at rooming."},
        headers=_key())
    assert recorded.status_code == 201, recorded.text
    entry = recorded.json()
    assert (entry["source"], entry["status"], entry["note"]) == ("reported", "active",
                                                                 "Reported at rooming.")
    assert entry["recordedBy"] == str(users["ma"].id)
    stopped = client("ma").post(url, json={"medication": {"text": "Fish oil (synthetic)"},
                                           "status": "stopped"}, headers=_key())
    assert stopped.status_code == 201
    listed = client("md").get(url)
    assert listed.status_code == 200, listed.text
    assert [i["id"] for i in listed.json()["items"]] == [entry["id"], stopped.json()["id"]]
    assert [i["id"] for i in client("md").get(url, params={"status": "stopped"}).json()[
        "items"]] == [stopped.json()["id"]]
    row = _sql(practice, "SELECT intent, reported_boolean, status FROM clinical.medication_request "
               "WHERE id = :i", i=entry["id"])[0]
    assert tuple(row) == ("plan", True, "active")
    assert {r.patient_id for r in _audited(practice, "phi-write")} == {kaia}


def test_the_list_refuses(client: Any, practice: Practice, rx: Rx) -> None:
    kaia = practice.patients["kaia"]
    url = f"{API}/patients/{kaia}/medications"
    assert client("fd").get(url).status_code == 403
    assert client("fd").post(url, json={"medication": {"text": "x"}},
                             headers=_key()).status_code == 403
    assert client("md").get(url, params={"status": "draft"}).status_code == 422
    assert client("ma").post(url, json={"medication": {}}, headers=_key()).status_code == 422
    assert client("md-b").get(url).status_code == 404
    restricted = client("md").get(f"{API}/patients/{practice.patients['restricted']}/medications")
    assert restricted.status_code == 403 and restricted.json()["code"] == "break-glass-required"


# ----------------------------------------------------------------------- the whole way
def test_draft_check_override_sign_and_send(client: Any, practice: Practice,
                                           rx: Rx) -> None:
    kaia = practice.patients["kaia"]
    allergy = _allergy(practice, rx)
    reported = client("ma").post(f"{API}/patients/{kaia}/medications",
                                 json={"medication": AMOXICILLIN}, headers=_key()).json()
    created = _draft(client, practice, rx)
    assert created.status_code == 201, created.text
    draft = created.json()
    assert created.headers["ETag"] == '"1"' and draft["transmission"] == {"status": "not-sent"}

    checked = client("md").post(f"{API}/prescriptions/{draft['id']}/safety-check")
    assert checked.status_code == 200, checked.text
    alerts = {a["kind"]: a for a in checked.json()["alerts"]}
    assert (alerts["allergy"]["severity"], alerts["allergy"]["allergyId"]) == ("high",
                                                                               str(allergy))
    assert (alerts["duplicate-medication"]["severity"],
            alerts["duplicate-medication"]["medicationId"]) == ("warning", reported["id"])
    read = client("md").get(f"{API}/prescriptions/{draft['id']}")
    assert read.headers["ETag"] == '"1"' and read.json()["safetyCheckedAt"]  # A58
    assert read.json()["alerts"] == checked.json()["alerts"]

    refused = _sign(client, draft["id"], '"1"')
    assert refused.status_code == 422, refused.text
    index = [a["id"] for a in read.json()["alerts"]].index(alerts["allergy"]["id"])
    assert refused.json()["errors"] == [{"in": "body", "pointer": f"/alerts/{index}",
                                         "code": "override-required"}]

    overridden = client("md").post(f"{API}/alerts/{alerts['allergy']['id']}/override",
                                   json={"reason": "Tolerated amoxicillin in 2024."})
    assert overridden.status_code == 200, overridden.text
    assert overridden.json()["override"]["overriddenBy"] == str(rx.md.id)

    key = _key()
    signed = _sign(client, draft["id"], '"1"', key)
    assert signed.status_code == 200, signed.text
    body = signed.json()
    assert (body["status"], body["transmission"]["status"], body["prescriberId"]) == (
        "active", "queued", str(rx.md.id))
    assert signed.headers["ETag"] == '"2"'
    again = _sign(client, draft["id"], '"1"', key)  # the same key: the stored answer, once
    assert again.status_code == 200 and again.json() == body

    outbox = _sql(practice, "SELECT id, payload, message_type, ordering_key FROM "
                  "admin.integration_message WHERE tenant_id = :t", t=practice.clinic)
    assert len(outbox) == 1
    assert (outbox[0].payload, outbox[0].message_type, outbox[0].ordering_key) == (
        {"prescriptionId": draft["id"]}, "NewRx", f"prescription:{draft['id']}")
    tx = _sql(practice, "SELECT status, integration_message_id FROM admin.erx_transaction "
              "WHERE medication_request_id = :r", r=draft["id"])
    assert [tuple(t) for t in tx] == [("queued", outbox[0].id)]
    prov = _sql(practice, "SELECT activity_code FROM clinical.provenance WHERE target_id = :r",
                r=draft["id"])
    assert [p.activity_code for p in prov] == ["LA"]
    events = _sql(practice, "SELECT type, data FROM admin.event_log WHERE subject = :s "
                  "ORDER BY seq", s=f"prescription/{draft['id']}")
    assert [(e.type, e.data) for e in events] == [
        ("prescription.signed", {"patientId": str(kaia)}),
        ("prescription.transmission-updated", {"transmissionStatus": "queued"})]
    listed = client("ma").get(f"{API}/patients/{kaia}/medications").json()["items"]
    mine = next(i for i in listed if i["id"] == draft["id"])
    assert (mine["source"], mine["prescriptionId"]) == ("prescription", draft["id"])
    assert {r.patient_id for r in _audited(practice, "sign")} == {kaia}

    # The adapter builds the NewRx from the tables, in the clinic's session.
    message = _in_clinic(practice, lambda s: service.build_new_rx(
        s, UUID(draft["id"]), now=dt.datetime.now(dt.UTC)))
    found = message.as_json()
    assert errors(NEW_RX, found) == []
    assert found["patient"] == {"name": {"family": "Lindgren118", "given": ["Kaia401"]},
                                "birthDate": "1984-03-09"}
    assert found["medication"]["quantity"] == {"value": "30", "unit": "capsule"}
    assert found["prescriber"]["name"] == {"family": "Lindqvist58", "given": ["Avery401"]}

    # Delivered, then the pharmacy's answers through /hooks/erx: filed once.
    sent = _in_clinic(practice, lambda s: service.record_sent(s, UUID(draft["id"])))
    assert (sent.status, sent.duplicate) == ("sent", False)
    reply = example("rx-status-accepted.json") | {"correlationId": draft["id"],
                                                  "responseId": f"SIM-{uuid.uuid4().hex[:8]}"}
    filed = _in_clinic(practice, lambda s: service.record_status(s, reply))
    assert (filed.status, filed.duplicate) == ("accepted", False)
    late = example("rx-status-rejected.json") | {"correlationId": draft["id"]}
    for answer in (reply, late):
        def again(s: Any, a: dict[str, Any] = answer) -> Any:
            return service.record_status(s, a)
        assert _in_clinic(practice, again).duplicate
    final = client("md").get(f"{API}/prescriptions/{draft['id']}").json()["transmission"]
    assert final["status"] == "accepted" and "message" not in final


def test_a_rejected_prescription_shows_the_pharmacys_reason(
        client: Any, practice: Practice, rx: Rx) -> None:
    draft = _draft(client, practice, rx).json()
    client("md").post(f"{API}/prescriptions/{draft['id']}/safety-check")
    assert _sign(client, draft["id"], '"1"').status_code == 200
    reply = example("rx-status-rejected-code-only.json") | {
        "correlationId": draft["id"], "responseId": f"SIM-{uuid.uuid4().hex[:8]}"}
    filed = _in_clinic(practice, lambda s: service.record_status(s, reply))
    assert (filed.status, filed.duplicate) == ("rejected", False)
    shown = client("md").get(f"{API}/prescriptions/{draft['id']}").json()["transmission"]
    assert shown == {"status": "rejected", "updatedAt": shown["updatedAt"],
                     "message": "The pharmacy could not process the prescription."}
    with pytest.raises(NotFound):  # an unknown correlationId
        _in_clinic(practice, lambda s: service.record_status(
            s, reply | {"correlationId": str(uuid.uuid4())}))
    with pytest.raises(ValidationFailed):
        _in_clinic(practice, lambda s: service.record_status(s, reply | {"status": "lost"}))


# ------------------------------------------------------------------ drafts and refusals
def test_drafts_edit_and_enter_in_error(client: Any, practice: Practice,
                                        rx: Rx) -> None:
    draft = _draft(client, practice, rx).json()
    url = f"{API}/prescriptions/{draft['id']}"
    client("md").post(f"{url}/safety-check")
    changed = client("md").patch(url, json={"daysSupply": 7, "quantity": {
        "value": 21, "unit": "capsule"}}, headers={"If-Match": '"1"'})
    assert changed.status_code == 200, changed.text
    assert changed.headers["ETag"] == '"2"' and "safetyCheckedAt" not in changed.json()
    stale = client("md").patch(url, json={"refills": 1}, headers={"If-Match": '"1"'})
    assert stale.status_code == 412 and stale.headers["ETag"] == '"2"'
    assert client("md").patch(url, json={"refills": 1}).status_code == 428
    assert client("ma").patch(url, json={"refills": 1},
                              headers={"If-Match": '"2"'}).status_code == 403
    assert client("md").patch(url, json={"refills": 12},
                              headers={"If-Match": '"2"'}).status_code == 422
    stale_check = _sign(client, draft["id"], '"2"')
    assert stale_check.json()["errors"] == [{"in": "body", "pointer": "/alerts",
                                             "code": "safety-check-stale"}]
    wrong = client("md").post(f"{url}/entered-in-error", json={"reason": "Wrong patient."})
    assert wrong.status_code == 200 and wrong.json()["status"] == "entered-in-error"
    assert client("md").post(f"{url}/entered-in-error",
                             json={"reason": "Twice."}).status_code == 409
    assert client("ma").post(f"{url}/entered-in-error",
                             json={"reason": "No."}).status_code == 403
    assert client("md").post(f"{url}/entered-in-error", json={}).status_code == 422
    assert _sql(practice, "SELECT count(*) FROM admin.integration_message WHERE tenant_id = :t",
                t=practice.clinic)[0][0] == 0


def test_prescriptions_refuse(client: Any, practice: Practice, rx: Rx) -> None:
    unknown = _draft(client, practice, rx, medication={"codings": [
        {"system": RX, "code": "999999999"}]})
    assert unknown.status_code == 422
    assert unknown.json()["errors"] == [{"in": "body", "pointer": "/medication/codings/0/code",
                                         "code": "invalid-reference"}]
    assert _draft(client, practice, rx, refills=12).status_code == 422
    other = _draft(client, practice, rx, patientId=str(practice.patients["marcus"]))
    assert other.status_code == 422  # the visit is Kaia's
    assert client("ma").post(f"{API}/prescriptions", json={
        "patientId": str(practice.patients["kaia"]), "medication": AMOXICILLIN},
        headers=_key()).status_code == 403
    draft = _draft(client, practice, rx).json()
    url = f"{API}/prescriptions/{draft['id']}"
    for user in ("fd", "md-b"):
        assert client(user).get(url).status_code in (403, 404)
    assert client("md-b").get(url).status_code == 404
    assert client("ma").post(f"{url}/safety-check").status_code == 403
    assert client("md").post(f"{API}/prescriptions/not-a-uuid/safety-check").status_code == 422
    checked = client("md").post(f"{url}/safety-check").json()
    assert checked["alerts"] == []  # no allergy, nothing else on the list
    assert client("ma").post(f"{url}/sign-and-send", headers={
        "If-Match": '"1"', **_key()}).status_code == 403
    missing_key = client("md").post(f"{url}/sign-and-send", headers={"If-Match": '"1"'})
    assert missing_key.status_code == 400 and missing_key.json()["code"] == \
        "idempotency-key-missing"


def _sign_in_rn(practice: Practice, users: dict[str, CurrentUser]) -> None:
    """A real RN user at facility A1 (scheduling's ``users`` has none on this branch)."""
    admin = create_engine(sync_url(), poolclass=NullPool)
    db = setup_session(admin, practice.clinic)
    try:
        dev = DEV_USERS["rn"]
        user = M["app_user"](tenant_id=practice.clinic, keycloak_subject=str(uuid.uuid4()),
                             username=f"rn.{uuid.uuid4().hex[:8]}", display_name=dev.display_name)
        db.add(user)
        db.flush()
        users["rn"] = CurrentUser(id=user.id, organization_id=practice.clinic, roles=dev.roles,
                                  facility_ids=frozenset({practice.facility}),
                                  display_name=dev.display_name)
        db.commit()
    finally:
        db.close()
        admin.dispose()


def test_rn_is_refused_against_the_real_tables(client: Any, practice: Practice, rx: Rx,
                                               users: dict[str, CurrentUser]) -> None:
    """D110 (for the clinical advisors to confirm, Q21): RN holds prescriptions:create and
    :update in core, but the service refuses the role with 403 permission-denied before it
    writes anything."""
    _sign_in_rn(practice, users)
    body = {"patientId": str(practice.patients["kaia"]), "encounterId": rx.encounter,
            "medication": AMOXICILLIN, "pharmacyId": str(rx.pharmacy)}
    count = "SELECT count(*) FROM clinical.medication_request WHERE tenant_id = :t"
    before = _sql(practice, count, t=practice.clinic)[0][0]
    refused = client("rn").post(f"{API}/prescriptions", json=body, headers=_key())
    assert refused.status_code == 403 and refused.json()["code"] == "permission-denied"
    draft = _draft(client, practice, rx).json()
    edit = client("rn").patch(f"{API}/prescriptions/{draft['id']}", json={"refills": 1},
                              headers={"If-Match": '"1"'})
    assert edit.status_code == 403 and edit.json()["code"] == "permission-denied"
    assert _sql(practice, count, t=practice.clinic)[0][0] == before + 1  # the MD's draft only
    assert client("rn").get(f"{API}/prescriptions/{draft['id']}").headers["ETag"] == '"1"'


def test_override_refuses(client: Any, practice: Practice, rx: Rx) -> None:
    _allergy(practice, rx)
    draft = _draft(client, practice, rx).json()
    [alert] = client("md").post(f"{API}/prescriptions/{draft['id']}/safety-check").json()[
        "alerts"]
    url = f"{API}/alerts/{alert['id']}/override"
    assert client("ma").post(url, json={"reason": "Because."}).status_code == 403
    assert client("md").post(url, json={"reason": "ab"}).status_code == 422
    assert client("md-b").post(url, json={"reason": "Not mine."}).status_code == 404
    assert client("md").post(url, json={"reason": "Tolerated it."}).status_code == 200
    assert client("md").post(url, json={"reason": "Again."}).status_code == 409
    # A new check cancels the old alerts: the old one can't be overridden any more.
    client("md").post(f"{API}/prescriptions/{draft['id']}/safety-check")
    assert client("md").post(url, json={"reason": "Old alert."}).status_code == 404
