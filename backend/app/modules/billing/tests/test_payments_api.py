"""recordPayment (`POST /patients/{patientId}/payments`) with the in-memory fakes: the contract's
status codes, problem codes and field codes, and the receipt written with the payment.
Synthetic data only."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable
from typing import Any
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.deps import CLINIC_A, CLINIC_B, DEV_USERS, tenant_db
from app.modules.files.tests.fakes import FakeFileCrypto

from ..repository import EncounterLink, PatientForPayment
from .conftest import cash
from .fakes import MemoryFileStore, World

Client = Callable[[str], TestClient]


def _patient(world: World, clinic: UUID = CLINIC_A, merged_into: UUID | None = None
             ) -> UUID:
    patient_id = uuid4()
    world.add_patient(clinic, PatientForPayment(id=patient_id, name="Mai Nguyen",
                                                merged_into_id=merged_into))
    return patient_id


def _pay(client: TestClient, patient_id: UUID, body: dict[str, Any],
         key: str | None = None) -> Any:
    return client.post(f"/api/v1/patients/{patient_id}/payments", json=body,
                       headers={"Idempotency-Key": key or str(uuid4())})


def _field_errors(response: Any) -> list[tuple[str, str]]:
    return [(e["pointer"], e["code"]) for e in response.json()["errors"]]


def _opened(store: MemoryFileStore, crypto: FakeFileCrypto, file_row: dict[str, Any]) -> bytes:
    """The stored receipt, decrypted as the download does."""
    sealed, _ = store.objects[file_row["storage_key"]]
    return asyncio.run(crypto.open(sealed, file_row["wrapped_data_key"],
                                   context=file_row["storage_key"]))


def _nothing_written(world: World, store: MemoryFileStore) -> bool:
    return not world.payments and not store.objects and not any(s.files for s in world.sessions)


# ------------------------------------------------------------------------------------ success
def test_a_cash_copay_is_recorded_with_its_receipt(as_user: Client, world: World,
                                                   store: MemoryFileStore,
                                                   fake_crypto: FakeFileCrypto) -> None:
    patient_id = _patient(world)
    appointment_id, encounter_id = uuid4(), uuid4()
    world.appointments[CLINIC_A] = {appointment_id: patient_id}
    world.encounters[CLINIC_A] = {encounter_id: EncounterLink(patient_id, appointment_id)}

    response = _pay(as_user("fd"), patient_id, cash(appointmentId=str(appointment_id),
                                                    encounterId=str(encounter_id)))

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["patientId"] == str(patient_id)
    assert body["appointmentId"] == str(appointment_id)
    assert body["encounterId"] == str(encounter_id)
    assert body["amount"] == {"value": "25.00", "currency": "USD"}
    assert body["method"] == "cash" and body["refund"] is False
    assert body["collectedByUserId"] == str(DEV_USERS["fd"].id)
    assert body["collectedAt"].endswith("Z")
    assert "processorReference" not in body and "refundOfPaymentId" not in body
    assert response.headers["Location"] == f"/api/v1/patients/{patient_id}/payments/{body['id']}"
    assert response.headers["ETag"] == '"1"'

    (payment,) = world.payments
    assert str(payment.id) == body["id"] and str(payment.receipt_file_id) == body["receiptFileId"]
    (session,) = world.sessions
    assert session.commits == 1
    (file_row,) = session.files
    assert file_row["id"] == payment.receipt_file_id
    assert file_row["purpose"] == "receipt" and file_row["bucket"] == "clean"
    assert file_row["storage_key"] == f"{CLINIC_A}/{payment.receipt_file_id}"
    sealed, content_type = store.objects[file_row["storage_key"]]
    assert content_type == "application/pdf" and b"%PDF-" not in sealed  # encrypted at rest
    data = _opened(store, fake_crypto, file_row)
    assert data.startswith(b"%PDF-")
    assert file_row["sha256"] == hashlib.sha256(data).hexdigest()
    assert file_row["size_bytes"] == len(data)
    assert b"(Receipt number: " + body["id"].encode() + b")" in data


def test_a_check_payment_keeps_its_number_and_note(as_user: Client, world: World,
                                                   store: MemoryFileStore,
                                                   fake_crypto: FakeFileCrypto) -> None:
    patient_id = _patient(world)

    response = _pay(as_user("bil"), patient_id, {
        "amount": {"value": "1250.50", "currency": "USD"}, "method": "check",
        "checkNumber": "1042", "note": "Copay for the visit"})

    assert response.status_code == 201, response.text
    assert response.json()["method"] == "check"
    assert response.json()["amount"]["value"] == "1250.50"
    (payment,) = world.payments
    assert (payment.check_number, payment.note) == ("1042", "Copay for the visit")
    assert str(payment.amount) == "1250.50"
    ((file_row,),) = [session.files for session in world.sessions]
    data = _opened(store, fake_crypto, file_row)
    assert b"(Check number: 1042)" in data and b"(Amount paid: $1,250.50 USD)" in data


def test_no_data_key_no_payment(as_user: Client, world: World, store: MemoryFileStore,
                                fake_crypto: FakeFileCrypto) -> None:
    """The receipt can't be encrypted, so nothing is stored in clear and no payment is made
    (D104: never a payment without its receipt)."""
    fake_crypto.data_keys.unavailable = True
    response = _pay(as_user("fd"), _patient(world), cash())
    assert response.status_code == 503 and response.json()["code"] == "service-unavailable"
    assert _nothing_written(world, store)


def test_a_payment_does_not_need_break_glass(as_user: Client, world: World) -> None:
    """The fakes have no chart check at all: nothing in the route asks for one. The live test
    shows the same against a restricted patient in the database."""
    assert _pay(as_user("fd"), _patient(world), cash(method="ach")).status_code == 201


# ------------------------------------------------------------------------- 400, 403, 404, 409
@pytest.mark.parametrize("name", ["md", "none"])
def test_payments_create_is_required(as_user: Client, world: World, store: MemoryFileStore,
                                     name: str) -> None:
    response = _pay(as_user(name), _patient(world), cash())

    assert response.status_code == 403
    assert response.json()["code"] == "permission-denied"
    assert _nothing_written(world, store)


class _UnusedDatabase:
    """Stands in for core's Database: a request that reaches the database fails the test."""

    def tenant_session(self, *args: object, **kwargs: object) -> object:
        raise AssertionError("the database was used")


def test_the_idempotency_key_is_required(app: FastAPI, world: World,
                                         store: MemoryFileStore) -> None:
    """Core's own tenant_db, not the fake: it refuses the missing key before anything runs."""
    del app.dependency_overrides[tenant_db]
    app.state.db = _UnusedDatabase()
    client = TestClient(app, raise_server_exceptions=False)
    client.headers["X-Dev-User"] = "fd"

    response = client.post(f"/api/v1/patients/{_patient(world)}/payments", json=cash())

    assert response.status_code == 400, response.text
    assert response.json()["code"] == "idempotency-key-missing"
    assert _nothing_written(world, store)


def test_an_unknown_patient_is_not_found(as_user: Client, world: World,
                                         store: MemoryFileStore) -> None:
    response = _pay(as_user("fd"), uuid4(), cash())

    assert response.status_code == 404 and response.json()["code"] == "not-found"
    assert _nothing_written(world, store)


def test_another_clinics_patient_is_not_found(as_user: Client, world: World) -> None:
    response = _pay(as_user("fd"), _patient(world, clinic=CLINIC_B), cash())

    assert response.status_code == 404
    assert not world.payments


def test_a_merged_patient_is_refused(as_user: Client, world: World,
                                     store: MemoryFileStore) -> None:
    survivor = _patient(world)
    response = _pay(as_user("fd"), _patient(world, merged_into=survivor), cash())

    assert response.status_code == 409
    assert response.json()["code"] == "patient-merged"
    assert response.json()["mergedIntoId"] == str(survivor)
    assert _nothing_written(world, store)


# ---------------------------------------------------------------------------------------- 422
@pytest.mark.parametrize(("body", "expected"), [
    ({"method": "card"}, [("/method", "not-allowed-value")]),
    ({"method": "card", "cardSessionId": str(uuid4())},
     [("/method", "not-allowed-value"), ("/cardSessionId", "not-allowed-value")]),
    ({"cardSessionId": str(uuid4())}, [("/cardSessionId", "not-allowed-value")]),
    ({"checkNumber": "1042"}, [("/checkNumber", "conflicting-fields")]),
    ({"method": "ach", "checkNumber": "1042"}, [("/checkNumber", "conflicting-fields")]),
    ({"amount": {"value": "0.00", "currency": "USD"}}, [("/amount/value", "out-of-range")]),
    ({"amount": {"value": "-25.00", "currency": "USD"}}, [("/amount/value", "out-of-range")]),
], ids=["card", "card-with-session", "card-session-with-cash", "check-number-with-cash",
        "check-number-with-ach", "zero", "negative"])
def test_business_rules(as_user: Client, world: World, store: MemoryFileStore,
                        body: dict[str, Any], expected: list[tuple[str, str]]) -> None:
    response = _pay(as_user("fd"), _patient(world), cash(**body))

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "business-rule-violation"
    assert _field_errors(response) == expected
    assert _nothing_written(world, store)


def test_the_appointment_and_encounter_must_be_this_patients(as_user: Client, world: World,
                                                             store: MemoryFileStore) -> None:
    patient_id, other = _patient(world), _patient(world)
    mine, theirs = uuid4(), uuid4()
    world.appointments[CLINIC_A] = {mine: patient_id, theirs: other}
    their_visit, unlinked, other_visit = uuid4(), uuid4(), uuid4()
    world.encounters[CLINIC_A] = {their_visit: EncounterLink(other, theirs),
                                  unlinked: EncounterLink(patient_id, None),
                                  other_visit: EncounterLink(patient_id, uuid4())}
    cases = [
        ({"appointmentId": str(theirs)}, [("/appointmentId", "invalid-reference")]),
        ({"appointmentId": str(uuid4())}, [("/appointmentId", "invalid-reference")]),
        ({"encounterId": str(their_visit)}, [("/encounterId", "invalid-reference")]),
        ({"encounterId": str(uuid4())}, [("/encounterId", "invalid-reference")]),
        # this patient's encounters, but not of the appointment given
        ({"appointmentId": str(mine), "encounterId": str(unlinked)},
         [("/encounterId", "invalid-reference")]),
        ({"appointmentId": str(mine), "encounterId": str(other_visit)},
         [("/encounterId", "invalid-reference")]),
    ]
    for body, expected in cases:
        response = _pay(as_user("fd"), patient_id, cash(**body))
        assert response.status_code == 422, (body, response.text)
        assert response.json()["code"] == "business-rule-violation"
        assert _field_errors(response) == expected, body
    assert _nothing_written(world, store)
    # the encounter alone, without its appointment, is fine
    assert _pay(as_user("fd"), patient_id, cash(encounterId=str(unlinked))).status_code == 201


@pytest.mark.parametrize("body", [
    cash(amount={"value": "25", "currency": "USD"}),
    cash(amount={"value": "25.00", "currency": "EUR"}),
    cash(method="bitcoin"),
    cash(checkNumber="1" * 41),
    cash(note="n" * 501),
    cash(processorReference="TEST-TXN-1"),
])
def test_the_shape_is_validated(as_user: Client, world: World, body: dict[str, Any]) -> None:
    response = _pay(as_user("fd"), _patient(world), body)

    assert response.status_code == 422, response.text
    assert response.json()["code"] == "validation-failed"
    assert not world.payments
