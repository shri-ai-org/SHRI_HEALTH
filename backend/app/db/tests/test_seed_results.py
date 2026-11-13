"""The history patients' lab results and imaging reports (app.db.seed.results). The table's
rules need no database; the written rows, the second run and /fhir's restricted chart do.
Synthetic data only."""
from __future__ import annotations

import asyncio
import datetime as dt
from collections import Counter
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A
from app.db import fhir_store as fs
from app.db.models import systems
from app.db.seed import demo, history, results
from app.db.seed.starter import sid
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE
from app.db.tests.test_seed import migrator_engine
from app.db.tests.test_seed_history import _as_migrator

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
        assert results.performed(s) >= order, (s.patient, s.code)
        assert results.issued(s) > results.performed(s)
        if later:                                        # reported before the next visit
            assert results.issued(s).date() < later[0], (s.patient, s.code)
        assert results.issued(s) < dt.datetime(2026, 11, 1, tzinfo=dt.UTC)   # all in the past


def test_two_to_four_lab_dates_per_patient_and_every_history_patient_has_results() -> None:
    dates: dict[int, set[dt.date]] = {}
    for s in S:
        if s.category == "LAB":
            dates.setdefault(s.patient, set()).add(s.done[0])
    assert set(dates) == set(history.HISTORY)
    assert all(2 <= len(d) <= 4 for d in dates.values()), dates


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


def _load() -> int:
    async def go() -> int:
        engine = _as_migrator()
        try:
            await history.load_history(engine)
            return await results.load_results(engine)
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
            return await history.load_history(engine), await results.load_results(engine)
        finally:
            await engine.dispose()

    assert asyncio.run(again()) == (0, 0)
    assert counts() == before
