"""recordPayment against a live database, as shri_app, with nothing replaced but the sign-in and
the file store's folder (a temporary one): core's tenant_db, idempotency and audit, the real
repository and store_generated(). Each test gets fresh clinics with a real front-desk user in
each. Runs where ``TEST_DATABASE_URL`` is set. Synthetic data only.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import Engine, create_engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import CLINIC_A, CLINIC_B, DEV_USER_HEADER, DEV_USERS, CurrentUser, current_user
from app.db.models import MAPPERS
from app.db.tests import builders as b
from app.db.tests.conftest import (
    TEST_DATABASE_URL,
    make_tenant,
    open_session,
    switch_to_role,
    sync_url,
)
from app.main import create_app
from app.modules.files import storage

from .. import api
from ..repository import NewPayment, SqlPaymentRepository

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]
M = MAPPERS
USERS = {"fd": CLINIC_A, "fd-b": CLINIC_B}  # a front-desk user in each clinic


@pytest.fixture
def admin() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    yield engine
    engine.dispose()


@pytest.fixture
def clinics(admin: Engine) -> dict[UUID, UUID]:
    return {CLINIC_A: make_tenant(admin), CLINIC_B: make_tenant(admin)}


@pytest.fixture
def app_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)
    switch_to_role(engine, "shri_app")
    yield engine
    engine.dispose()


@pytest.fixture
def chart(app_engine: Engine, clinics: dict[UUID, UUID]) -> Iterator[Callable[[UUID], Session]]:
    """A shri_app session in a clinic, for building test charts."""
    opened: list[Session] = []

    def open_in(clinic: UUID) -> Session:
        session = open_session(app_engine, clinics[clinic])
        opened.append(session)
        return session
    yield open_in
    for session in opened:
        session.close()
        session.bind.close()  # type: ignore[union-attr]


@pytest.fixture
def users(chart: Callable[[UUID], Session], clinics: dict[UUID, UUID]
          ) -> dict[str, CurrentUser]:
    signed: dict[str, CurrentUser] = {}
    for name, clinic in USERS.items():
        session = chart(clinic)
        made = b.practitioner(session, "Lindqvist58", name.replace("-", ""))
        session.commit()
        dev = DEV_USERS["fd"]
        signed[name] = CurrentUser(id=made["user"].id, organization_id=clinics[clinic],
                                   roles=dev.roles, facility_ids=dev.facility_ids,
                                   display_name=dev.display_name)
    return signed


@pytest.fixture
def app(users: dict[str, CurrentUser], tmp_path: Path) -> Iterator[FastAPI]:
    application = create_app(Settings(environment="test", auth_mode="dev_header",
                                      database_url=TEST_DATABASE_URL))
    switch_to_role(application.state.db.engine.sync_engine, "shri_app")

    def signed_in(request: Request) -> CurrentUser:
        return users[request.headers[DEV_USER_HEADER]]

    application.dependency_overrides[current_user] = signed_in
    application.dependency_overrides[storage.file_store] = (
        lambda: storage.LocalFileStore(tmp_path / "files"))
    yield application


@pytest.fixture
def client(app: FastAPI) -> Iterator[Callable[[str], TestClient]]:
    with TestClient(app, raise_server_exceptions=False) as test_client:
        def as_user(name: str) -> TestClient:
            test_client.headers[DEV_USER_HEADER] = name
            return test_client
        yield as_user
        assert test_client.portal is not None
        test_client.portal.call(app.state.db.dispose)


def _pay(client: TestClient, patient_id: Any, body: dict[str, Any]) -> Any:
    return client.post(f"/api/v1/patients/{patient_id}/payments", json=body,
                       headers={"Idempotency-Key": str(uuid.uuid4())})


def _payments(admin: Engine, patient_id: Any) -> list[Any]:
    with admin.connect() as c:
        return list(c.execute(text("SELECT * FROM admin.patient_payment WHERE patient_id = :p"),
                              {"p": patient_id}))


def test_the_payment_its_receipt_row_and_the_stored_bytes(
        client: Callable[[str], TestClient], chart: Callable[[UUID], Session], admin: Engine,
        clinics: dict[UUID, UUID], users: dict[str, CurrentUser], tmp_path: Path) -> None:
    db = chart(CLINIC_A)
    patient = b.patient(db, "Okafor", "Ada")
    appointment = M["appointment"](status="booked", subject_patient_id=patient.id,
                                   start=b.NOW, end=b.NOW + dt.timedelta(minutes=20))
    db.add(appointment)
    db.commit()

    response = _pay(client("fd"), patient.id, {
        "amount": {"value": "40.00", "currency": "USD"}, "method": "check",
        "checkNumber": "2201", "note": "Copay", "appointmentId": str(appointment.id)})

    assert response.status_code == 201, response.text
    body = response.json()
    (row,) = _payments(admin, patient.id)
    assert str(row.id) == body["id"] and str(row.receipt_file_id) == body["receiptFileId"]
    assert str(row.amount) == "40.00" and row.method == "check" and row.check_number == "2201"
    assert row.appointment_id == appointment.id and row.is_refund is False
    assert row.tenant_id == clinics[CLINIC_A]
    assert row.collected_by_user_id == users["fd"].id == row.created_by_user_id
    with admin.connect() as c:
        file_row = c.execute(text("SELECT * FROM admin.binary_object WHERE id = :i"),
                             {"i": row.receipt_file_id}).one()
    assert file_row.tenant_id == clinics[CLINIC_A]
    assert (file_row.bucket, file_row.purpose, file_row.state) == ("clean", "receipt", "clean")
    assert file_row.content_type == "application/pdf" and file_row.wrapped_data_key is None
    assert file_row.storage_key == f"{clinics[CLINIC_A]}/{row.receipt_file_id}"
    stored = (tmp_path / "files" / file_row.storage_key).read_bytes()
    assert stored.startswith(b"%PDF-")
    assert file_row.sha256 == hashlib.sha256(stored).hexdigest()
    assert file_row.size_bytes == len(stored)
    assert b"(Patient: Ada Okafor)" in stored and b"(Test practice)" in stored
    with admin.connect() as c:
        audited = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE patient_id = :p "
                                 "AND tenant_id = :t"),
                            {"p": patient.id, "t": clinics[CLINIC_A]}).scalar_one()
    assert audited >= 1  # core's x-audit row, committed with the payment


def test_a_restricted_patient_pays_without_break_glass(
        client: Callable[[str], TestClient], chart: Callable[[UUID], Session],
        admin: Engine) -> None:
    db = chart(CLINIC_A)
    patient = b.patient(db, "Achebe", "Chinua", meta_security=["R"])
    db.commit()

    response = _pay(client("fd"), patient.id, {"amount": {"value": "25.00", "currency": "USD"},
                                               "method": "cash"})

    assert response.status_code == 201, response.text
    assert len(_payments(admin, patient.id)) == 1


def test_another_clinics_patient_is_not_found(
        client: Callable[[str], TestClient], chart: Callable[[UUID], Session],
        admin: Engine) -> None:
    db = chart(CLINIC_A)
    patient = b.patient(db, "Mensah", "Kofi")
    db.commit()

    response = _pay(client("fd-b"), patient.id, {"amount": {"value": "25.00", "currency": "USD"},
                                                 "method": "cash"})

    assert response.status_code == 404, response.text
    assert _payments(admin, patient.id) == []


def test_a_merged_patient_is_refused(client: Callable[[str], TestClient],
                                     chart: Callable[[UUID], Session], admin: Engine,
                                     users: dict[str, CurrentUser]) -> None:
    db = chart(CLINIC_A)
    keep, dup = b.patient(db, "Diallo", "Awa"), b.patient(db, "Diallo", "Ava")
    db.commit()
    db.add(M["patient_merge"](surviving_patient_id=keep.id, merged_patient_id=dup.id,
                              reason="Same person", performed_at=b.NOW,
                              performed_by_user_id=users["fd"].id))
    keep.link.append(M["patient_link"](other_patient_id=dup.id, type="replaces"))
    dup.link.append(M["patient_link"](other_patient_id=keep.id, type="replaced-by"))
    dup.active = False
    db.commit()

    response = _pay(client("fd"), dup.id, {"amount": {"value": "25.00", "currency": "USD"},
                                           "method": "cash"})

    assert response.status_code == 409, response.text
    assert response.json()["mergedIntoId"] == str(keep.id)
    assert _payments(admin, dup.id) == []


class _FailsAfterInsert(SqlPaymentRepository):
    async def insert_payment(self, db: AsyncSession, payment: NewPayment) -> None:
        await super().insert_payment(db, payment)
        raise RuntimeError("synthetic failure after the insert")


def test_a_rolled_back_request_leaves_no_payment(
        app: FastAPI, client: Callable[[str], TestClient], chart: Callable[[UUID], Session],
        admin: Engine, clinics: dict[UUID, UUID], tmp_path: Path) -> None:
    db = chart(CLINIC_A)
    patient = b.patient(db, "Owusu", "Efua")
    db.commit()
    app.dependency_overrides[api.repository] = _FailsAfterInsert

    response = _pay(client("fd"), patient.id, {"amount": {"value": "25.00", "currency": "USD"},
                                               "method": "cash"})

    assert response.status_code == 500
    assert _payments(admin, patient.id) == []
    # The receipt's row rolled back with the payment; its bytes are the orphan the purge removes.
    (orphan,) = (tmp_path / "files" / str(clinics[CLINIC_A])).iterdir()
    with admin.connect() as c:
        assert c.execute(text("SELECT count(*) FROM admin.binary_object WHERE id = :i"),
                         {"i": uuid.UUID(orphan.name)}).scalar_one() == 0
