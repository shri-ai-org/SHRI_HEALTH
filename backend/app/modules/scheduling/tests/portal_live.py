"""Shared live fixtures for the patient portal's reads (B8a): a practice with two synthetic patients
in the same clinic (scheduling's ``build_practice``), each with an upcoming and a past visit, the
past one with its after-visit summary; plus, for patient A, records the portal must never show
(a proposed and an entered-in-error appointment, a preliminary and an entered-in-error summary)
and one held summary (D90). The rows are written directly, as a superuser pinned to the clinic,
because the after-visit summary's writer (#157) isn't merged.

The app is the real one: staff as shri_app, the portal as shri_portal (``portal_db``, D93), with
the patient development sign-in (X-Dev-Patient, D108). Synthetic data only."""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.deps import DEV_PATIENT_CLINIC_HEADER, DEV_PATIENT_HEADER
from app.db.models import MAPPERS, systems
from app.db.tests.conftest import TEST_DATABASE_URL, switch_to_role, sync_url
from app.main import create_app
from app.modules.encounters.portal_repository import AVS_TYPE_CODE

from .conftest import Practice, build_practice, setup_session

M = MAPPERS
API = "/api/v1"


@dataclass
class PortalChart:
    practice: Practice
    a: UUID
    b: UUID
    ids: dict[str, UUID] = field(default_factory=dict)  # "a-next", "a-avs", "b-past", ...


def _appointment(db: Session, p: Practice, patient: UUID, start: dt.datetime, status: str,
                 reason: str = "Follow-up on headaches.") -> Any:
    appt = M["appointment"](
        tenant_id=p.clinic, status=status, start=start, end=start + dt.timedelta(minutes=20),
        minutes_duration=20, subject_patient_id=patient,
        ext_appointment_type_id=p.types["FU"], ext_facility_id=p.facility,
        patient_instruction="Please arrive 15 minutes early.",
        **({"ext_cancelled_at": start - dt.timedelta(days=1),
            "cancelation_reason_system": systems.SHRI_LOCAL,
            "cancelation_reason_code": "pat"} if status == "cancelled" else {}))
    appt.participant = [
        M["appointment_participant"](actor_patient_id=patient, status="accepted"),
        M["appointment_participant"](actor_practitioner_id=p.provider, status="accepted")]
    db.add(appt)
    db.flush()
    db.add(M["appointment_reason"](appointment_id=appt.id, reason_code_text=reason))
    db.flush()
    return appt


def _visit(db: Session, p: Practice, patient: UUID, appt: Any) -> Any:
    enc = M["encounter"](status="finished", class_="AMB", subject_patient_id=patient,
                         appointment_id=appt.id, period_start=appt.start,
                         period_end=appt.end, ext_facility_id=p.facility)
    enc.participant = [M["encounter_participant"](
        type_system=systems.V3_PARTICIPATION_TYPE, type_code="PPRF",
        individual_practitioner_id=p.provider)]
    db.add(enc)
    db.flush()
    return enc


def _summary(db: Session, patient: UUID, enc: Any, made: dt.datetime, *,
             status: str = "current", doc_status: str | None = None) -> Any:
    doc = M["document_reference"](
        status=status, doc_status=doc_status, type_system=systems.LOINC,
        type_code=AVS_TYPE_CODE, type_display="Summary of episode note",
        subject_patient_id=patient, date=made, description="After-visit summary",
        context_encounter_id=enc.id, ext_origin="generated")
    db.add(doc)
    db.flush()
    return doc


def build_portal_chart(admin: Engine) -> PortalChart:
    p = build_practice(admin)
    chart = PortalChart(p, p.patients["kaia"], p.patients["marcus"])
    now = dt.datetime.now(dt.UTC).replace(microsecond=0)
    db = setup_session(admin, p.clinic)
    try:
        location = db.execute(text("SELECT location_id FROM admin.facility WHERE id = :f"),
                              {"f": p.facility}).scalar_one()
        db.add(M["address"](location_id=location, line=["100 Test Lane"], city="Springfield",
                            state="IL", postal_code="62701", country="US", use="work"))
        db.add(M["online_booking_setting"](tenant_id=p.clinic, is_enabled=True,
                                           cancel_cutoff_hours=24, reschedule_cutoff_hours=96))
        for who, patient, hour in (("a", chart.a, 0), ("b", chart.b, 1)):  # one provider
            nxt = _appointment(db, p, patient, now + dt.timedelta(days=3, hours=hour), "booked")
            past = _appointment(db, p, patient, now - dt.timedelta(days=10, hours=-hour),
                                "fulfilled")
            enc = _visit(db, p, patient, past)
            avs = _summary(db, patient, enc, past.end + dt.timedelta(hours=1))
            chart.ids |= {f"{who}-next": nxt.id, f"{who}-past": past.id,
                          f"{who}-avs": avs.id}
        # Patient A only: what the portal never shows, and a held summary.
        chart.ids["a-proposed"] = _appointment(db, p, chart.a, now + dt.timedelta(days=5),
                                               "proposed").id
        chart.ids["a-eie-appt"] = _appointment(db, p, chart.a, now + dt.timedelta(days=6),
                                                 "entered-in-error").id
        chart.ids["a-cancelled"] = _appointment(db, p, chart.a, now + dt.timedelta(days=8),
                                                "cancelled").id
        for key, days, kw in (("a-draft-avs", 20, {"doc_status": "preliminary"}),
                              ("a-wrong-avs", 30, {"status": "entered-in-error"}),
                              ("a-held-avs", 40, {})):
            visit = _appointment(db, p, chart.a, now - dt.timedelta(days=days), "fulfilled")
            chart.ids[key] = _summary(db, chart.a, _visit(db, p, chart.a, visit),
                                      visit.end + dt.timedelta(hours=1), **kw).id
            chart.ids[key.replace("avs", "appt")] = visit.id
        clinician = M["app_user"](tenant_id=p.clinic, keycloak_subject=str(uuid.uuid4()),
                                  username=f"hold.{uuid.uuid4().hex[:8]}",
                                  display_name="Holding clinician (synthetic)")
        db.add(clinician)
        db.flush()
        db.add(M["release_hold"](tenant_id=p.clinic, patient_id=chart.a,
                                 document_reference_id=chart.ids["a-held-avs"],
                                 reason="risk-of-harm", held_by_user_id=clinician.id))
        db.commit()
    finally:
        db.close()
    return chart


@pytest.fixture
def portal_chart() -> Iterator[PortalChart]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        yield build_portal_chart(admin)
    finally:
        admin.dispose()


@pytest.fixture
def portal_app() -> Iterator[TestClient]:
    """The real app: staff as shri_app, the portal as shri_portal, development sign-ins. One
    client for the whole test, so every request runs on the event loop the engines' pooled
    connections belong to; ``portal_client`` signs a patient in per request."""
    app = create_app(Settings(environment="test", auth_mode="dev_header",
                              patient_auth_mode="dev_header", database_url=TEST_DATABASE_URL,
                              portal_database_url=TEST_DATABASE_URL))
    switch_to_role(app.state.db.engine.sync_engine, "shri_app")
    switch_to_role(app.state.portal_db.engine.sync_engine, "shri_portal")
    with TestClient(app, raise_server_exceptions=False) as lifespan:
        yield lifespan
        assert lifespan.portal is not None
        lifespan.portal.call(app.state.db.dispose)
        lifespan.portal.call(app.state.portal_db.dispose)


@dataclass(frozen=True)
class SignedIn:
    """Requests as one patient, through the development sign-in (X-Dev-Patient, D108)."""
    client: TestClient
    headers: dict[str, str]

    def get(self, url: str, params: dict[str, Any] | None = None) -> Any:
        return self.client.get(url, params=params, headers=self.headers)


def portal_client(client: TestClient, chart: PortalChart, patient: UUID) -> SignedIn:
    return SignedIn(client, {DEV_PATIENT_HEADER: str(patient),
                             DEV_PATIENT_CLINIC_HEADER: str(chart.practice.clinic)})


def audit_rows(clinic: UUID) -> list[Any]:
    admin = create_engine(sync_url(), poolclass=NullPool)
    try:
        with admin.connect() as c:
            return list(c.execute(text(
                "SELECT actor_type, actor_user_id, patient_id, category FROM audit.audit_event "
                "WHERE tenant_id = :t ORDER BY id"), {"t": clinic}))
    finally:
        admin.dispose()
