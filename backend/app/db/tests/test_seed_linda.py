"""Linda Thompson complete for the demo (app.db.seed.linda): her after-visit summaries and her
refill-ready prescription, against a real database, with the file store in memory and real
AES-256-GCM over fake data keys. Synthetic data only."""
from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.db.seed import demo, history, images, linda
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_seed import migrator_engine
from app.db.tests.test_seed_history import _as_migrator
from app.db.tests.test_seed_results import FILES, _load
from app.modules.files.tests.fakes import MemoryFileStore

__all__ = ["migrator_engine"]       # a fixture, used by name
LINDA = sid(demo.PATIENT, 3)
DEMO_DAY = dt.date(2026, 11, 20)


def load_linda(files: images.SeedFiles = FILES) -> int:
    async def go() -> int:
        engine = _as_migrator()
        try:
            return await linda.load_linda(engine, files)
        finally:
            await engine.dispose()
    return asyncio.run(go())


def _seeded(migrator_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    load_linda()


def test_the_refill_is_not_an_nsaid_codeine_or_controlled_and_runs_past_the_demo() -> None:
    assert linda.OMEPRAZOLE.code == "198051"           # omeprazole 20 mg DR capsule, RxNorm
    names = {m.product.code for m in history.HISTORY[3].medications}
    assert linda.OMEPRAZOLE.code not in names          # no duplicate warning against her list
    ends = linda.REFILL_VISIT + dt.timedelta(days=60)
    assert 5 <= (ends - DEMO_DAY).days <= 9            # 28 November
    plan = next(v for v in history.HISTORY[3].visits if v.day == linda.REFILL_VISIT).plan
    assert "Omeprazole 20 mg once daily" in plan       # the note says why


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_summary_for_each_signed_visit_stored_encrypted_once(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    _seeded(migrator_engine, monkeypatch)
    query = text(
        "SELECT d.context_encounter_id, d.date, d.ext_composition_id, b.id, b.purpose, b.state, "
        "b.storage_key, b.wrapped_data_key, b.content_type FROM clinical.document_reference d "
        "JOIN clinical.document_reference_content c ON c.document_reference_id = d.id "
        "JOIN admin.binary_object b ON b.id = c.attachment_binary_object_id "
        "WHERE d.subject_patient_id = :p AND d.type_code = '34133-9' AND d.status = 'current' "
        "ORDER BY d.date")
    with admin_engine.connect() as c:
        rows = c.execute(query, {"p": LINDA}).all()
        signed = c.execute(text(
            "SELECT count(*) FROM clinical.composition WHERE subject_patient_id = :p "
            "AND status IN ('final', 'amended')"), {"p": LINDA}).scalar_one()
    visits = [v.start + linda.SUMMARY_AFTER for v in history.HISTORY[3].visits]
    assert len(rows) == signed == 4 and [r.date for r in rows] == visits
    assert all(r.ext_composition_id for r in rows)
    store = FILES.store
    assert isinstance(store, MemoryFileStore)
    for r in rows:
        assert (r.purpose, r.state, r.content_type) == (
            "after-visit-summary", "clean", "application/pdf")
        sealed = asyncio.run(store.get(r.storage_key))
        assert sealed.startswith(b"SHF1") and b"Linda" not in sealed       # ciphertext only
        pdf = asyncio.run(FILES.crypto.open(sealed, r.wrapped_data_key, context=r.storage_key))
        assert pdf.startswith(b"%PDF") and b"Linda Thompson" in pdf
    september = asyncio.run(FILES.crypto.open(asyncio.run(store.get(rows[-1].storage_key)),
                                              rows[-1].wrapped_data_key,
                                              context=rows[-1].storage_key))
    assert b"omeprazole" in september
    assert load_linda() == 0                           # a second run writes nothing
    with admin_engine.connect() as c:
        assert c.execute(query, {"p": LINDA}).all() == rows


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_omeprazole_prescription_is_refill_ready_and_the_alerts_stay(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    _seeded(migrator_engine, monkeypatch)
    with admin_engine.connect() as c:
        rx: Any = c.execute(text(
            "SELECT m.id, m.status, m.intent, m.authored_on, m.ext_signed_at, "
            "m.ext_signed_by_user_id, m.dispense_request_performer_pharmacy_id AS pharmacy, "
            "m.dispense_request_quantity_value AS quantity, "
            "m.dispense_request_expected_supply_duration_value AS days, "
            "m.dispense_request_number_of_repeats_allowed AS refills, "
            "(SELECT d.text FROM clinical.dosage d WHERE d.medication_request_id = m.id) AS sig, "
            "(SELECT a.text FROM clinical.annotation a WHERE a.medication_request_id = m.id) "
            "AS note "
            "FROM clinical.medication_request m WHERE m.subject_patient_id = :p "
            "AND m.medication_codeable_concept_code = '198051'"), {"p": LINDA}).one()
        erx = c.execute(text(
            "SELECT message_type, direction, status, occurred_at, pharmacy_id "
            "FROM admin.erx_transaction WHERE medication_request_id = :m"), {"m": rx.id}).all()
        provenance = c.execute(text(
            "SELECT count(*) FROM clinical.provenance WHERE target_id = :m "
            "AND reason_text = :r"),
            {"m": rx.id, "r": history.IMPORT_REASON}).scalar_one()
        proposals = c.execute(text(
            "SELECT count(*) FROM clinical.medication_request WHERE subject_patient_id = :p "
            "AND intent = 'proposal'"), {"p": LINDA}).scalar_one()
        alerts = c.execute(text(
            "SELECT (SELECT count(*) FROM clinical.allergy_intolerance WHERE patient_id = :p "
            "AND code_code = '2670' AND clinical_status = 'active'), "
            "(SELECT count(*) FROM clinical.medication_request WHERE subject_patient_id = :p "
            "AND medication_codeable_concept_code = '198014' AND status = 'active')"),
            {"p": LINDA}).one()
    signed = linda._signed(linda.REFILL_VISIT)
    assert (rx.status, rx.intent, rx.authored_on, rx.ext_signed_at) == (
        "active", "order", signed, signed)
    assert rx.ext_signed_by_user_id == history.DOCTOR_USER and rx.pharmacy == demo.PHARMACY_ID
    assert (rx.quantity, rx.days, rx.refills, rx.sig, rx.note) == (
        60, 60, 2, linda.REFILL_SIG, linda.REFILL_NOTE)
    assert [(e.message_type, e.direction, e.status, e.pharmacy_id) for e in erx] == [
        ("NewRx", "outbound", "accepted", demo.PHARMACY_ID)]
    assert erx[0].occurred_at > signed and provenance == 1 and proposals == 0
    assert tuple(alerts) == (1, 1)                     # codeine intolerance; naproxen listed
