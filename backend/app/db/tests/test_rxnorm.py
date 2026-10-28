"""The RxNorm loader (app.db.terminology.rxnorm) on a closed sample of the 2026-10-05 Current
Prescribable Content release (tests/data/rxnorm: oxycodone 5 MG tablets, generic and two
brands, and amoxicillin 500 MG capsules, with everything they point at)."""
from __future__ import annotations

from collections.abc import Iterator
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.terminology import rxnorm
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, sync_url

DATA = Path(__file__).with_name("data") / "rxnorm"
RELEASE = date(2026, 10, 5)
OXY_TAB, ROXICODONE, OXAYDO, AMOX_CAP = "1049621", "1049623", "1664448", "308191"
OXYCODONE, AMOXICILLIN = "7804", "723"


@pytest.fixture(scope="module")
def release() -> rxnorm.Release:
    return rxnorm.read_release(DATA, RELEASE)


def _props(release: rxnorm.Release) -> dict[str, dict[str, set[str]]]:
    out: dict[str, dict[str, set[str]]] = {}
    for code, _, props in rxnorm.concepts(release):
        for name, value in props:
            out.setdefault(code, {}).setdefault(name, set()).add(value)
    return out


# ============================================================================ the release
def test_products_carry_what_the_drug_search_and_safety_checks_need(
        release: rxnorm.Release) -> None:
    p = _props(release)[OXY_TAB]
    assert p == {"tty": {"SCD"}, "name": {"oxycodone hydrochloride 5 MG Oral Tablet"},
                 "strength": {"5 MG"}, "dose_form": {"Oral Tablet"}, "route": {"Oral"},
                 "ingredient": {OXYCODONE}, "precise_ingredient": {"82063"},
                 "dea_schedule": {"CII"}}
    assert _props(release)[AMOX_CAP]["ingredient"] == {AMOXICILLIN}
    assert "dea_schedule" not in _props(release)[AMOX_CAP]


def test_the_display_is_the_prescribable_name(release: rxnorm.Release) -> None:
    display = {code: d for code, d, _ in rxnorm.concepts(release)}
    assert display[OXY_TAB] == "oxyCODONE HCl 5 MG Oral Tablet"     # PSN, Tall Man lettering
    assert display[OXYCODONE] == "oxycodone"


def test_a_brand_has_its_name_its_generics_ingredients_and_the_drugs_schedule(
        release: rxnorm.Release) -> None:
    p = _props(release)
    assert p[ROXICODONE]["brand_name"] == {"Roxicodone"}
    assert p[ROXICODONE]["ingredient"] == {OXYCODONE}
    # The labels give Oxaydo its own CII; Roxicodone has none and takes its generic's.
    assert p[OXAYDO]["dea_schedule"] == p[ROXICODONE]["dea_schedule"] == {"CII"}


def test_ingredients_are_loaded_for_allergies(release: rxnorm.Release) -> None:
    p = _props(release)
    assert p[OXYCODONE] == {"tty": {"IN"}} and p[AMOXICILLIN] == {"tty": {"IN"}}
    assert p["82063"] == {"tty": {"PIN"}, "ingredient": {OXYCODONE}}
    loaded = {code for code, _, _ in rxnorm.concepts(release)}
    assert not loaded & {"1014614", "317541", "219740"}   # components, dose forms, brands


def test_the_most_restrictive_schedule_wins() -> None:
    r = rxnorm.Release(version=RELEASE, tty={"1": "SCD"}, name={"1": "x"})
    r.schedules["1"] = {"CIV", "CII"}
    assert rxnorm._schedule(r, "1") == "CII"


# ============================================================================ the load
@pytest.fixture(scope="module")
def migrator_engine() -> Iterator[Engine]:
    engine = create_engine(sync_url(), poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def _as_migrator(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()

    yield engine
    engine.dispose()


def _load(engine: Engine, r: rxnorm.Release) -> dict[str, int]:
    with Session(engine) as db, db.begin():
        return rxnorm.load(db, r)


def _stored(admin_engine: Engine) -> dict[str, tuple[str, bool]]:
    with admin_engine.connect() as c:
        return {row.code: (row.display, row.is_active) for row in c.execute(text(
            "SELECT c.code, c.display, c.is_active FROM admin.concept c JOIN admin.code_system s "
            "ON s.id = c.code_system_id WHERE s.code = 'RXNORM'"))}


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_load_stores_concepts_and_properties_and_a_rerun_changes_nothing(
        release: rxnorm.Release, migrator_engine: Engine, admin_engine: Engine,
        app_engine: Engine) -> None:
    counts = _load(migrator_engine, release)
    assert counts["concepts"] == 7          # anything else loaded before is made inactive
    first = _stored(admin_engine)
    assert first[OXY_TAB] == ("oxyCODONE HCl 5 MG Oral Tablet", True)
    with admin_engine.connect() as c:
        props_before = c.execute(text("SELECT count(*) FROM admin.concept_property")).scalar_one()
        version = c.execute(text("SELECT version, license_note FROM admin.code_system "
                                 "WHERE code = 'RXNORM'")).one()
    assert version.version == "2026-10-05" and "no licence required" in version.license_note
    _load(migrator_engine, release)
    assert _stored(admin_engine) == first
    with admin_engine.connect() as c:
        assert c.execute(text("SELECT count(*) FROM admin.concept_property")).scalar_one() == \
            props_before
    with app_engine.connect() as c:                      # the API reads it, under no clinic
        rows = c.execute(text(
            "SELECT p.value FROM admin.concept c JOIN admin.concept_property p ON p.concept_id "
            "= c.id WHERE c.code = :c AND p.property = 'dea_schedule'"), {"c": OXY_TAB}).all()
        assert [r.value for r in rows] == ["CII"]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_concept_a_later_release_drops_is_made_inactive_never_deleted(
        release: rxnorm.Release, migrator_engine: Engine, admin_engine: Engine) -> None:
    _load(migrator_engine, release)
    later = rxnorm.read_release(DATA, date(2026, 11, 2))
    del later.tty[AMOX_CAP]
    assert _load(migrator_engine, later)["retired"] == 1
    assert _stored(admin_engine)[AMOX_CAP] == ("amoxicillin 500 MG Oral Capsule", False)
    _load(migrator_engine, release)                      # and back again
    assert _stored(admin_engine)[AMOX_CAP][1] is True
