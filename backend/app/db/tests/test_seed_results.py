"""The history patients' lab results and imaging reports (app.db.seed.results). The table's
rules need no database; the written rows, the second run and /fhir's restricted chart do.
Synthetic data only."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import shutil
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.seed import demo, history, images, results
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_seed import migrator_engine
from app.db.tests.test_seed_history import _as_migrator
from app.modules.files.tests.fakes import FakeFileCrypto, MemoryFileStore

__all__ = ["migrator_engine"]       # a fixture, used by name
S = results.STUDIES
ANASTROZOLE = "199224"              # RxNorm: an aromatase inhibitor


# ================================================================== the table, no database
def test_each_study_is_ordered_at_a_visit_done_after_it_and_reported_before_the_next() -> None:
    for s in S:
        days = [v.day for v in history.HISTORY[s.patient].visits]
        assert s.ordered_at in days, (s.patient, s.code)
        order = next(v.start for v in history.HISTORY[s.patient].visits if v.day == s.ordered_at)
        later = [d for d in days if d > s.ordered_at]
        assert results.performed(s) >= order + results.SIGNED_AFTER, (s.patient, s.code)
        assert results.issued(s) > results.performed(s)
        if later:                                        # reported before the next visit
            assert results.issued(s).date() < later[0], (s.patient, s.code)
        assert results.issued(s) < dt.datetime(2026, 11, 1, tzinfo=dt.UTC)   # all in the past


def test_two_to_four_lab_dates_per_patient_and_every_history_patient_has_results() -> None:
    """Linda Thompson, the demo's patient, has her graph series (Vimal's assignment, 16 Nov):
    six lab dates, on her visits and nurse checks."""
    dates: dict[int, set[dt.date]] = {}
    for s in S:
        if s.category == "LAB":
            dates.setdefault(s.patient, set()).add(s.done[0])
    assert set(dates) == set(history.HISTORY)
    assert all(2 <= len(d) <= 4 for n, d in dates.items() if n != 3), dates
    assert len(dates[3]) == 6


def test_linda_has_five_to_eight_values_for_each_graph_and_they_fit_her_chart() -> None:
    def series(code: str) -> list[tuple[dt.date, Decimal]]:
        return sorted((s.done[0], Decimal(v)) for s in S if s.patient == 3
                      for c, v in s.values if c == code)
    creatinine, egfr = series("2160-0"), series("98979-8")
    crp, vitamin_d = series("1988-5"), series("62292-8")
    assert all(5 <= len(x) <= 8 for x in (creatinine, egfr, crp, vitamin_d))
    assert [d for d, _ in creatinine] == [d for d, _ in egfr]          # drawn together
    assert [v for _, v in creatinine] == sorted(v for _, v in creatinine)   # a slow drift
    assert all(results._result(3, "2160-0", str(v)).flag is None for _, v in creatinine)
    assert all(results._result(3, "98979-8", str(v)).flag is None for _, v in egfr)
    assert max(crp, key=lambda x: x[1])[0] == dt.date(2026, 9, 29)    # the September flare
    assert all(results._result(3, "62292-8", str(v)).flag is None for _, v in vitamin_d)
    visits = {v.day for v in history.HISTORY[3].visits}
    nurse = {dt.date(2026, 1, 6), dt.date(2026, 4, 7), dt.date(2026, 7, 21)}
    assert {d for d, _ in creatinine + crp + vitamin_d} <= visits | nurse


def test_every_code_is_listed_with_one_unit_and_each_value_reads() -> None:
    units: dict[str, set[str]] = {}
    for (code, _), (unit, _, _) in results.RANGES.items():
        units.setdefault(code, set()).add(unit)
    assert all(len(u) == 1 for u in units.values()), units
    for s in S:
        assert s.code in results.LOINC
        assert bool(s.findings) == bool(s.impression) and bool(s.findings) != bool(s.values)
        for code, value in s.values:
            assert code in results.LOINC and code in units, code
            Decimal(value)


def test_the_values_match_the_signed_notes() -> None:
    def values(n: int, code: str) -> list[tuple[dt.date, Decimal]]:
        return [(s.done[0], Decimal(v)) for s in S if s.patient == n
                for c, v in s.values if c == code]
    a1c = [v for _, v in values(2, "4548-4")]
    assert a1c == [Decimal("7.9"), Decimal("7.2"), Decimal("7.1")]   # March's was at the visit
    ldl = dict(values(2, "13457-7"))
    assert ldl[dt.date(2026, 6, 16)] == 92 and ldl[dt.date(2026, 9, 15)] == 66
    for s in S:                                          # Friedewald: LDL = TC - HDL - TG/5
        v = dict(s.values)
        if "13457-7" in v:
            calc = Decimal(v["2093-3"]) - Decimal(v["2085-9"]) - Decimal(v["2571-8"]) / 5
            assert abs(calc - Decimal(v["13457-7"])) <= 1, s
    assert [v for _, v in values(4, "19935-6")] == [410, 500, 530]   # James's peak flows
    dxa = [s for s in S if s.code == "38268-9"]
    assert [s.patient for s in dxa] == [5] and dxa[0].done[0] == dt.date(2026, 7, 9)
    assert "-1.8 at the left femoral neck" in (dxa[0].impression or "")
    meds = {m.product.code for m in history.HISTORY[5].medications}
    assert ANASTROZOLE in meds                           # a bone scan only on the inhibitor
    mammogram = next(s for s in S if s.code == "26346-7")
    assert mammogram.done[0] == dt.date(2026, 4, 7) and "BI-RADS 2" in (mammogram.impression
                                                                        or "")


def test_flags_follow_the_ranges() -> None:
    robert = results._result(2, "4548-4", "7.9")
    assert (robert.flag, robert.low, robert.high) == ("H", Decimal("4.0"), Decimal("5.6"))
    assert results._result(3, "2160-0", "0.78").flag is None      # a woman's range
    assert results._result(2, "2160-0", "1.40").flag == "H"
    assert results._result(7, "19926-5", "56").flag == "L"        # FEV1/FVC under 70%


# ================================================================== the written rows


#: The seed's file store and key service, in memory (real AES-256-GCM, fake data keys).
FILES = images.SeedFiles(MemoryFileStore(), FakeFileCrypto())


def _load(files: images.SeedFiles = FILES) -> int:
    async def go() -> int:
        engine = _as_migrator()
        try:
            await history.load_history(engine)
            return await results.load_results(engine, files)
        finally:
            await engine.dispose()
    return asyncio.run(go())


def _reports(admin: Engine) -> Counter[tuple[int, str]]:
    with admin.connect() as c:
        rows = c.execute(text(
            "SELECT r.subject_patient_id, k.category_code FROM clinical.diagnostic_report r "
            "JOIN clinical.diagnostic_report_category k ON k.diagnostic_report_id = r.id "
            "WHERE r.id::text LIKE '5eed0040-%'")).all()
    patients = {sid(demo.PATIENT, p.n): p.n for p in demo.PATIENTS}
    return Counter((patients[r.subject_patient_id], r.category_code) for r in rows)


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_seed_writes_every_study_once_and_hides_the_restricted_chart_on_fhir(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    expected = Counter((s.patient, s.category) for s in S)
    assert _reports(admin_engine) == expected
    assert _load() == 0                                   # a second run writes nothing
    assert _reports(admin_engine) == expected
    with admin_engine.connect() as c:
        flags = c.execute(text(
            "SELECT o.value_quantity_value, i.interpretation_code, rr.low_value, rr.high_value "
            "FROM clinical.diagnostic_report_result x JOIN clinical.observation o "
            "ON o.id = x.observation_id LEFT JOIN clinical.observation_interpretation i "
            "ON i.observation_id = o.id LEFT JOIN clinical.observation_reference_range rr "
            "ON rr.observation_id = o.id WHERE x.diagnostic_report_id = :r"),
            {"r": sid(results.LAB_REPORT, 1)}).one()                  # Robert's first A1c
        assert tuple(flags) == (Decimal("7.9"), "H", Decimal("4.0"), Decimal("5.6"))
        mri = c.execute(text(
            "SELECT r.conclusion, string_agg(o.value_string, ' | ' ORDER BY x.sequence) "
            "FROM clinical.diagnostic_report r JOIN clinical.diagnostic_report_result x "
            "ON x.diagnostic_report_id = r.id JOIN clinical.observation o "
            "ON o.id = x.observation_id WHERE r.code_code = '30679-5' GROUP BY r.conclusion"
        )).one()
        assert "no nerve root compression" in mri[0] and mri[1].startswith("Technique:")
        c.execute(text("SET ROLE shri_fhir_reader"))
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, false)"),
                  {"t": str(CLINIC_A)})
        seen: Any = dict(c.execute(text(
            "SELECT subject_patient_id, count(*) FROM clinical.diagnostic_report "
            "WHERE id::text LIKE '5eed0040-%' GROUP BY 1")).tuples().all())
        c.execute(text("RESET ROLE"))
    assert sid(demo.PATIENT, 6) not in seen               # David Nguyen: restricted (D22)
    assert seen[sid(demo.PATIENT, 2)] == expected[(2, "LAB")]


def test_every_code_has_a_short_name_for_the_screen_and_keeps_its_loinc_name() -> None:
    """Vimal's A6: the screens show the text, a clinical short name; the coding keeps the code
    and NLM's long name."""
    assert set(results.SHORT) == set(results.LOINC)
    assert results.loinc("24331-1") == fs.Coded(
        systems.LOINC, "24331-1", "Lipid 1996 panel - Serum or Plasma", "Lipid panel")
    assert results.SHORT["13457-7"] == "LDL cholesterol (calculated)"
    assert results.SHORT["98979-8"] == "eGFR (CKD-EPI 2021)"
    assert results.SHORT["30679-5"] == "MR lumbar spine without contrast"
    assert all(len(name) <= 40 for name in results.SHORT.values())


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_short_names_are_stored_as_text_with_the_loinc_coding(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    with admin_engine.connect() as c:
        for table, code, short in (("diagnostic_report", "24331-1", "Lipid panel"),
                                   ("service_request", "24331-1", "Lipid panel"),
                                   ("observation", "13457-7", "LDL cholesterol (calculated)"),
                                   ("diagnostic_report", "30679-5",
                                    "MR lumbar spine without contrast")):
            names = {tuple(r) for r in c.execute(text(
                f"SELECT code_system, code_display, code_text FROM clinical.{table} "  # noqa: S608
                "WHERE code_code = :c AND subject_patient_id::text LIKE '5eed0017-%'"),
                {"c": code})}                         # the seeded patients' rows
            assert names == {("http://loinc.org", results.LOINC[code], short)}


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_rerun_over_past_visits_at_other_times_writes_nothing(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    """Thulasi's finding on #342: a database seeded before the San Jose move has the past
    visits at other times. History and results find them by their bookings' fixed IDs, so an
    additive rerun adds nothing and hits no duplicate key."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()

    def counts() -> tuple[int, ...]:
        with admin_engine.connect() as c:
            return tuple(c.execute(text(
                f"SELECT count(*) FROM clinical.{t}")).scalar_one()  # noqa: S608
                for t in ("appointment", "encounter", "service_request", "diagnostic_report",
                          "observation", "condition", "related_person"))

    before = counts()
    with admin_engine.begin() as c:                  # every past visit two hours later
        c.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))  # the triggers'
        c.execute(text("UPDATE clinical.appointment SET start = start + interval '2 hours', "
                       "\"end\" = \"end\" + interval '2 hours' WHERE id::text LIKE '5eed0035-%'"))
        c.execute(text("UPDATE clinical.encounter SET period_start = period_start + interval "
                       "'2 hours', period_end = period_end + interval '2 hours' "
                       "WHERE appointment_id::text LIKE '5eed0035-%'"))

    async def again() -> tuple[int, int]:
        engine = _as_migrator()
        try:
            return (await history.load_history(engine),
                    await results.load_results(engine, FILES))
        finally:
            await engine.dispose()

    assert asyncio.run(again()) == (0, 0)
    assert counts() == before


# ================================================================== the illustrative images
def test_the_manifest_pins_each_image_to_an_imaging_report_with_its_source() -> None:
    listed = images.manifest()
    assert {(i.patient, i.study_loinc) for i in listed} == {(4, "36643-5"), (3, "30679-5")}
    for i in listed:                                     # James's chest X-ray, Linda's MRI
        study = next(s for s in S if (s.patient, s.code) == (i.patient, i.study_loinc))
        assert study.category == "RAD" and i.content_type == "image/jpeg"
        assert len(i.data) == i.size_bytes <= 150 * 1024
    raw = json.loads((images.FOLDER / "manifest.json").read_text(encoding="utf-8"))
    for entry in raw["images"]:
        source = entry["source"]
        assert entry["label"] == "Illustrative image" and source["licence"] == "CC0-1.0"
        assert source["url"].startswith("https://commons.wikimedia.org/wiki/File:")
        assert (images.FOLDER / source["licenceText"]).is_file() and entry["checks"]
    assert sorted(p.name for p in images.FOLDER.iterdir()) == sorted(
        [e["file"] for e in raw["images"]] + ["CC0-1.0.txt", "manifest.json"])


def test_a_changed_or_missing_image_stops_the_seed(tmp_path: Path) -> None:
    for f in images.FOLDER.iterdir():
        shutil.copy(f, tmp_path / f.name)
    assert len(images.manifest(tmp_path)) == 2
    first = json.loads((tmp_path / "manifest.json").read_text())["images"][0]["file"]
    data = bytearray((tmp_path / first).read_bytes())
    data[-3] ^= 0xFF                                     # one byte changed, same size
    (tmp_path / first).write_bytes(bytes(data))
    with pytest.raises(images.ManifestMismatch, match="not the file the manifest pins"):
        images.manifest(tmp_path)
    (tmp_path / first).unlink()
    with pytest.raises(images.ManifestMismatch, match="missing"):
        images.manifest(tmp_path)


def test_the_seed_refuses_to_run_without_a_file_store_or_a_key_service(
        monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("SHRI_S3_ENDPOINT", "SHRI_FILE_STORE_DIR"):
        monkeypatch.delenv(name, raising=False)
    with pytest.raises(RuntimeError, match="need the file store"):
        images.seed_files()


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_images_are_stored_encrypted_on_their_reports_once_and_hidden_on_fhir(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    files = FILES                    # the reports may already be there, from another test
    memory = files.store
    assert isinstance(memory, MemoryFileStore)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load(files)
    query = text(
        "SELECT r.subject_patient_id, r.code_code, f.title, f.content_type, b.id, b.purpose, "
        "b.state, b.scan_status, b.bucket, b.storage_key, b.size_bytes, b.sha256, "
        "b.wrapped_data_key FROM clinical.diagnostic_report_presented_form f "
        "JOIN clinical.diagnostic_report r ON r.id = f.diagnostic_report_id "
        "JOIN admin.binary_object b ON b.id = f.binary_object_id "
        "WHERE r.id::text LIKE '5eed0040-%' ORDER BY r.code_code")
    with admin_engine.connect() as c:
        rows = c.execute(query).all()
    by_file = {i.sha256: i for i in images.manifest()}
    assert [(r.subject_patient_id, r.code_code, r.title) for r in rows] == [
        (sid(demo.PATIENT, 3), "30679-5", "Lumbar spine MRI, sagittal T2"),
        (sid(demo.PATIENT, 4), "36643-5", "Chest X-ray, PA view")]
    for r in rows:
        image = by_file[r.sha256]                        # the plaintext's hash and size
        assert (r.purpose, r.state, r.scan_status, r.bucket) == (
            "imaging", "clean", "pending", "clean")      # server-made: clean, never scanned
        assert r.size_bytes == image.size_bytes and r.content_type == image.content_type
        assert r.storage_key == f"{CLINIC_A}/{r.id}" and r.wrapped_data_key
        stored = asyncio.run(files.store.get(r.storage_key))
        assert stored.startswith(b"SHF1") and image.data not in stored      # ciphertext only
        assert asyncio.run(files.crypto.open(stored, r.wrapped_data_key,
                                             context=r.storage_key)) == image.data
    assert _load(files) == 0                             # a second run writes nothing
    with admin_engine.connect() as c:
        assert c.execute(query).all() == rows
        assert c.execute(text("SELECT count(*) FROM admin.binary_object "
                              "WHERE purpose = 'imaging'")).scalar_one() == 2
    assert sum(key[1] in {r.storage_key for r in rows} for key in memory.objects) == 2
    with admin_engine.begin() as c:                      # Linda's chart restricted (D22)
        c.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
        c.execute(text("UPDATE clinical.patient SET meta_security = ARRAY['R'] WHERE id = :p"),
                  {"p": sid(demo.PATIENT, 3)})
    with admin_engine.connect() as c:
        c.execute(text("SET ROLE shri_fhir_reader"))
        c.execute(text("SELECT set_config('app.current_tenant_id', :t, false)"),
                  {"t": str(CLINIC_A)})
        seen = c.execute(text(
            "SELECT r.subject_patient_id FROM clinical.diagnostic_report_presented_form f "
            "JOIN clinical.diagnostic_report r ON r.id = f.diagnostic_report_id")).scalars().all()
        c.execute(text("RESET ROLE"))
    assert seen == [sid(demo.PATIENT, 4)]                # James's only; Linda's hidden


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_changed_image_writes_no_result_at_all(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    for f in images.FOLDER.iterdir():
        shutil.copy(f, tmp_path / f.name)
    first = json.loads((tmp_path / "manifest.json").read_text())["images"][0]["file"]
    (tmp_path / first).write_bytes((tmp_path / first).read_bytes() + b"\0")
    monkeypatch.setattr(images, "FOLDER", tmp_path)
    monkeypatch.setattr(results, "manifest", lambda: images.manifest(tmp_path))
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    def counts() -> tuple[int, int]:
        with admin_engine.connect() as c:
            return (c.execute(text("SELECT count(*) FROM clinical.diagnostic_report "
                                   "WHERE id::text LIKE '5eed0040-%'")).scalar_one(),
                    c.execute(text("SELECT count(*) FROM admin.binary_object "
                                   "WHERE purpose = 'imaging'")).scalar_one())

    before = counts()
    with pytest.raises(images.ManifestMismatch):        # before any report or file
        _load()
    assert counts() == before


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_record_report_takes_clean_imaging_files_on_an_imaging_report_only(
        migrator_engine: Engine, admin_engine: Engine, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(demo, "POPULATION_SIZE", 5)
    with Session(migrator_engine) as db, db.begin():
        demo.load_demo(db)
    _load()
    with admin_engine.connect() as c:
        image, report = c.execute(text(
            "SELECT f.binary_object_id, r.id FROM clinical.diagnostic_report_presented_form f "
            "JOIN clinical.diagnostic_report r ON r.id = f.diagnostic_report_id LIMIT 1")).one()
        base = c.execute(text(
            "SELECT r.subject_patient_id, r.encounter_id, b.service_request_id, r.issued "
            "FROM clinical.diagnostic_report r JOIN clinical.diagnostic_report_based_on b "
            "ON b.diagnostic_report_id = r.id WHERE r.id = :r"), {"r": report}).one()

    def report_in(category: str, *pictures: fs.ImageIn) -> fs.ReportIn:
        return fs.ReportIn(
            patient_id=base[0], encounter_id=base[1], order_id=base[2], category=category,
            code=results.loinc("36643-5"), effective=base[3], issued=base[3],
            performer_organization_id=results.RADIOLOGY,
            results=(fs.ResultIn(results.loinc("18782-3"), text="Findings: clear."),),
            images=pictures)

    async def refused(data: fs.ReportIn) -> str:
        engine = _as_migrator()
        try:
            async with AsyncSession(engine) as db, db.begin():
                await db.execute(text("SET LOCAL search_path = clinical, admin, audit, public"))
                await db.execute(text("SELECT set_config('app.current_tenant_id', :t, true)"),
                                 {"t": str(CLINIC_A)})
                with pytest.raises(fs.InvalidInput) as caught:
                    await fs.SqlFhirStore().record_report(db, data)
                await db.rollback()
                return str(caught.value)
        finally:
            await engine.dispose()

    jpeg = fs.ImageIn(image, "image/jpeg", "Chest X-ray, PA view")
    assert "only an imaging report" in asyncio.run(refused(report_in("LAB", jpeg)))
    assert "JPEG or PNG" in asyncio.run(refused(report_in(
        "RAD", fs.ImageIn(image, "application/pdf", "x"))))
    assert "at most three" in asyncio.run(refused(report_in("RAD", *[jpeg] * 4)))
    assert "clean imaging file" in asyncio.run(refused(report_in(
        "RAD", fs.ImageIn(sid(demo.PATIENT, 3), "image/jpeg", "not a file"))))
