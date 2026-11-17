"""Linda Thompson complete for the demo (Vimal's assignment on #85, 16 Nov): what her portal
and her doctor's screens show beyond the history and the results.

- **After-visit summaries:** one for each past visit with a signed note, made as the check-out
  makes it (``app.modules.documents.after_visit_summary``): the PDF from the visit's own note
  (reason, diagnoses, the medicines started that day, the tests ordered, the patient
  instructions), stored encrypted through the file service (``store_generated``, the imaging
  seed's path) and recorded as a current, generated DocumentReference, dated five minutes
  after the note was signed.
- **Her medications as signed prescriptions** (Minalini, #85, 17 Nov): naproxen,
  cyclobenzaprine and acetaminophen, which the history used to record as reported, are
  prescriptions signed by demo.doctor at the end of the visit each started at (acetaminophen,
  which predates the history, at the first visit, where the list was taken), each with its sig,
  quantity, refills and her pharmacy, sent and accepted. The history records none of them
  (``History.prescribed``), so nothing is on the list twice, and the duplicate rule, which
  counts signed prescriptions, still warns on naproxen.
- **A refill-ready prescription:** omeprazole 20 mg delayed-release, once daily, started at her
  29 September visit (the note's plan says why), signed by demo.doctor at the end of that visit,
  60 days and two refills, sent to her preferred pharmacy and accepted. So it is active, signed,
  not a controlled substance, with no refill request yet, and its supply ends on 28 November,
  eight days after the demo. Not an NSAID and not a codeine product, so her alert scenarios
  stay as they are: codeine and acetaminophen raises the high allergy alert from her codeine
  intolerance, and naproxen the duplicate warning.

Each part is skipped when it is already there, so a second run changes nothing. As
shri_migrator, in the demo clinic, as the demo doctor, after ``results``. Synthetic data only.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import uuid
from decimal import Decimal

from sqlalchemy import Engine, select, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.db import TENANT_ID_INFO_KEY
from app.core.deps import CLINIC_A
from app.db import fhir_store as fs
from app.db.models import MAPPERS
from app.db.models.admin.medication import ErxTransaction
from app.db.seed.demo import CLINIC_ZONE, PATIENT, PATIENTS, PHARMACY_ID
from app.db.seed.history import (
    DOCTOR,
    DOCTOR_USER,
    HISTORY,
    IMPORT_REASON,
    _as_user,
    rx,
)
from app.db.seed.images import SeedFiles, seed_files
from app.db.seed.results import SHORT, STUDIES, _visit
from app.db.seed.starter import sid
from app.modules.documents import after_visit_summary as avs

M = MAPPERS
N = 3                                       # Linda Thompson
OMEPRAZOLE = rx("198051", "omeprazole 20 MG Delayed Release Oral Capsule")
REFILL_VISIT = dt.date(2026, 9, 29)
REFILL_SIG = "20 mg (1 capsule) by mouth once daily before breakfast"
REFILL_NOTE = "To protect the stomach while she takes naproxen."
#: Each of her medications' dispense request: (quantity, unit, days' supply, refills).
SUPPLY = {"198014": (Decimal(60), "tablet", 30, 2),     # naproxen 500 mg, twice daily as needed
          "828348": (Decimal(30), "tablet", 30, 1),     # cyclobenzaprine 10 mg, at bedtime
          "198440": (Decimal(100), "tablet", 30, 0)}    # acetaminophen 500 mg, as needed
SIGNED_AFTER = dt.timedelta(minutes=40)     # the history's notes are signed 40 minutes in
SUMMARY_AFTER = dt.timedelta(minutes=45)
SENT_AFTER = dt.timedelta(minutes=41)       # the pharmacy's acceptance, a minute after signing


def _signed(day: dt.date) -> dt.datetime:
    visit = next(v for v in HISTORY[N].visits if v.day == day)
    return visit.start + SIGNED_AFTER


async def _names(db: AsyncSession) -> tuple[str, str, str | None]:
    """The practice, the demo doctor and the visits' facility, as the seed wrote them."""
    practice = (await db.execute(text(
        "SELECT name FROM admin.tenant WHERE id = :t"), {"t": CLINIC_A})).scalar_one()
    doctor = (await db.execute(text(
        "SELECT concat_ws(' ', array_to_string(given, ' '), family) FROM clinical.human_name "
        "WHERE practitioner_id = :p ORDER BY created_at, id LIMIT 1"), {"p": DOCTOR})
              ).scalar_one()
    facility = (await db.execute(text(
        "SELECT f.name FROM clinical.encounter e JOIN admin.facility f "
        "ON f.id = e.ext_facility_id WHERE e.subject_patient_id = :p "
        "ORDER BY e.period_start LIMIT 1"), {"p": sid(PATIENT, N)})).scalar_one_or_none()
    return practice, doctor, facility


async def _summaries(db: AsyncSession, files: SeedFiles) -> int:
    practice, doctor, facility = await _names(db)
    person = next(p for p in PATIENTS if p.n == N)
    h, made = HISTORY[N], 0
    for visit in h.visits:
        encounter = await _visit(db, N, visit.day)
        if await avs.latest(db, encounter) is not None:
            continue
        note = (await db.execute(text(
            "SELECT id FROM clinical.composition WHERE encounter_id = :e "
            "AND status IN ('final', 'amended') ORDER BY date LIMIT 1"),
            {"e": encounter})).scalar_one_or_none()
        if note is None:                          # only a visit with a signed note has one
            continue
        medicines = [avs.Medication(m.product.display or "", m.sig)
                     for m in h.medications if m.started == visit.day]
        if visit.day == REFILL_VISIT:
            medicines.append(avs.Medication(OMEPRAZOLE.display or "", REFILL_SIG))
        details = avs.AfterVisitSummaryDetails(
            practice_name=practice, patient_name=f"{person.given} {person.family}",
            visit_start=visit.start, time_zone=CLINIC_ZONE.key, clinician_name=doctor,
            facility_name=facility, reason_for_visit=visit.reason,
            diagnoses=tuple(c.display or c.code or "" for c in visit.diagnoses),
            medications=tuple(medicines),
            orders=tuple(dict.fromkeys(SHORT[s.code] for s in STUDIES
                                       if s.patient == N and s.ordered_at == visit.day)),
            instructions=visit.instructions)
        await avs.store(db, files.store, files.crypto, patient_id=sid(PATIENT, N),
                        encounter_id=encounter, note_id=note, author_practitioner_id=DOCTOR,
                        details=details, generated_at=visit.start + SUMMARY_AFTER)
        made += 1
    return made


async def _prescribe(db: AsyncSession, store: fs.SqlFhirStore, product: fs.Coded, sig: str,
                     supply: tuple[Decimal, str, int, int], note: str, encounter: uuid.UUID,
                     signed_at: dt.datetime) -> int:
    """One prescription, signed at ``signed_at`` by demo.doctor through the seed's own signing;
    skipped when she already has it (a second run changes nothing)."""
    patient = sid(PATIENT, N)
    MR = M["medication_request"]
    if (await db.execute(select(MR.id).where(
            MR.subject_patient_id == patient, MR.intent == "order",
            MR.medication_codeable_concept_code == product.code))).first() is not None:
        return 0
    quantity, unit, days, refills = supply
    draft = await store.create_prescription(db, fs.PrescriptionIn(
        patient_id=patient, medication=product, encounter_id=encounter, dosage_text=sig,
        quantity=fs.DispenseQuantity(quantity, unit), days_supply=days, refills=refills,
        substitution_allowed=True, pharmacy_id=PHARMACY_ID))
    # The list's note; a note freezes once signed.
    db.add(M["annotation"](medication_request_id=draft.id, text=note, time=signed_at))
    await db.flush()
    version = (await db.execute(select(MR.meta_version_id).where(MR.id == draft.id))
               ).scalar_one()                   # the note is a new version of the draft
    await store.record_safety_check(db, draft.id, (), if_version=version)
    await _sign_as_imported(db, draft.id, version, signed_at)
    return 1


async def _prescriptions(db: AsyncSession, store: fs.SqlFhirStore) -> int:
    """Her three medications, then the refill-ready omeprazole."""
    h, written = HISTORY[N], 0
    first = h.visits[0].day
    for m in h.medications:
        day = m.started if any(v.day == m.started for v in h.visits) else first
        written += await _prescribe(db, store, m.product, m.sig, SUPPLY[m.product.code or ""],
                                    m.note, await _visit(db, N, day), _signed(day))
    return written + await _prescribe(
        db, store, OMEPRAZOLE, REFILL_SIG, (Decimal(60), "capsule", 60, 2), REFILL_NOTE,
        await _visit(db, N, REFILL_VISIT), _signed(REFILL_VISIT))


async def _sign_as_imported(db: AsyncSession, prescription_id: uuid.UUID, version: int,
                            signed_at: dt.datetime) -> None:
    """The prescription signed at the end of its past visit, as the history signs its notes
    (``history._sign_as_imported``): the store's sign_prescription always signs at the
    database's now(). The same checks hold (a sig, a quantity, a pharmacy, a current safety
    check with no unmitigated high alert, enforced again by the database); the Provenance
    carries the content's digest and says "synthetic demo import"; the NewRx went to the
    pharmacy and was accepted a minute later."""
    mr = await fs._prescription(db, prescription_id, version)
    signer = await fs._practitioner(db)
    sig = await fs._dosage_text(db, mr.id)
    if not sig or mr.dispense_request_quantity_value is None or (
            mr.dispense_request_performer_pharmacy_id is None):
        raise RuntimeError("the seed's prescription is incomplete")
    mr.status, mr.authored_on = "active", signed_at
    mr.ext_signed_at, mr.ext_signed_by_user_id = signed_at, signer.id
    mr.ext_signed_by_practitioner_id = signer.practitioner_id
    written = await fs._written(db, mr)
    activity, agent_type, signature_type = fs._SIGNED
    await fs._provenance(db, "MedicationRequest", written, activity, agent_type=agent_type,
                         reason=fs.Reason(IMPORT_REASON),
                         signature=(signature_type,
                                    fs._digest(await fs._prescription_content(db, mr, sig))))
    db.add(ErxTransaction(medication_request_id=mr.id, patient_id=mr.subject_patient_id,
                          pharmacy_id=mr.dispense_request_performer_pharmacy_id,
                          message_type="NewRx", direction="outbound", status="accepted",
                          occurred_at=signed_at + (SENT_AFTER - SIGNED_AFTER),
                          created_by_user_id=signer.id, updated_by_user_id=signer.id))
    await db.flush()


async def load_linda(engine: AsyncEngine, files: SeedFiles) -> int:
    """Writes what is missing; returns how many parts it wrote (summaries and
    prescriptions)."""
    store = fs.SqlFhirStore()
    async with AsyncSession(engine, expire_on_commit=False) as db, db.begin():
        db.info[TENANT_ID_INFO_KEY] = CLINIC_A
        await db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        await db.execute(text(
            "SELECT set_config('app.current_tenant_id', :t, true), "
            "set_config('app.correlation_id', 'seed-linda', true)"), {"t": str(CLINIC_A)})
        await _as_user(db, DOCTOR_USER)
        return await _summaries(db, files) + await _prescriptions(db, store)


def run(engine: Engine) -> int:
    """``load_linda`` for the seed's synchronous callers, with the file store and key service
    the environment configures (``seed_files``)."""
    async_engine = create_async_engine(engine.url.set(drivername="postgresql+psycopg"),
                                       poolclass=NullPool)

    async def go() -> int:
        files, keys = seed_files()
        try:
            return await load_linda(async_engine, files)
        finally:
            await keys.aclose()
            await async_engine.dispose()

    return asyncio.run(go())

