"""ICD-10-CM loading (app.db.terminology.icd10cm) and code search (app.db.terminology.search):
the order-file reader, then the load and the ranked search on a real database, as
shri_migrator for the load and shri_app for the search. Synthetic order-file lines in CMS's
format; the RxNorm part reuses test_rxnorm's synthetic release."""
from __future__ import annotations

from collections.abc import AsyncIterator, Iterator
from datetime import date
from typing import Any

import pytest
from pydantic import SecretStr
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.core.config import Settings
from app.core.db import Database
from app.db.terminology import icd10cm, rxnorm
from app.db.terminology import search as terms
from app.db.tests.conftest import (
    SKIP_WITHOUT_DATABASE,
    TEST_DATABASE_URL,
    make_tenant,
    switch_to_role,
    sync_url,
)
from app.db.tests.test_rxnorm import DATA, RELEASE


def _line(n: int, code: str, billable: bool, long: str) -> str:
    return f"{n:05d} {code:<7} {int(billable)} {long[:60]:<60} {long}"


ORDER_FILE = [
    _line(1, "E11", False, "Type 2 diabetes mellitus"),
    _line(2, "E119", True, "Type 2 diabetes mellitus without complications"),
    _line(3, "E1165", True, "Type 2 diabetes mellitus with hyperglycemia"),
    _line(4, "I10", True, "Essential (primary) hypertension"),
    _line(5, "G43", False, "Migraine"),
    _line(6, "G43009", True,
          "Migraine without aura, not intractable, without status migrainosus"),
]


# ================================================================== the order file (no database)
def test_the_order_file_gives_dotted_codes_billable_flags_and_long_names() -> None:
    codes = list(icd10cm.read_order_file(ORDER_FILE))
    assert [(c.code, c.billable) for c in codes] == [
        ("E11", False), ("E11.9", True), ("E11.65", True), ("I10", True), ("G43", False),
        ("G43.009", True)]
    assert codes[1].display == "Type 2 diabetes mellitus without complications"
    assert icd10cm.release_year(__import__("pathlib").Path("icd10cm_order_2026.txt")) == 2026


def test_a_line_in_another_shape_is_an_error() -> None:
    with pytest.raises(ValueError, match="line 2"):
        list(icd10cm.read_order_file([ORDER_FILE[0], "not an order line"]))


# ======================================================================== load and search


@pytest.fixture(scope="module")
def loaded() -> Iterator[None]:
    engine = create_engine(sync_url(), poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def _as_migrator(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()

    with Session(engine) as db, db.begin():
        icd10cm.load(db, list(icd10cm.read_order_file(ORDER_FILE)), date(2025, 10, 1))
        rxnorm.load(db, rxnorm.read_release(DATA, RELEASE))
    yield
    engine.dispose()


@pytest.fixture
async def app_db(admin_engine: Engine) -> AsyncIterator[Any]:
    database = Database(Settings(database_url=SecretStr(TEST_DATABASE_URL or "")))
    switch_to_role(database.engine.sync_engine, "shri_app")
    tenant = make_tenant(admin_engine)
    async with database.tenant_session(tenant, tenant) as s:
        yield s
    await database.dispose()


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_a_code_typed_with_or_without_its_dot_comes_first(loaded: None, app_db: Any) -> None:
    for q in ("E11.9", "e119"):
        matches, _ = await terms.search(app_db, "icd-10-cm", q)
        assert matches[0].code == "E11.9" and matches[0].position.rank == 0
    prefix, _ = await terms.search(app_db, "icd-10-cm", "E11")
    assert [m.code for m in prefix][:3] == ["E11", "E11.65", "E11.9"]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_words_in_any_order_typos_and_billable_only(loaded: None, app_db: Any) -> None:
    words, _ = await terms.search(app_db, "icd-10-cm", "diabetes type 2")
    assert {"E11", "E11.9", "E11.65"} <= {m.code for m in words}
    typo, _ = await terms.search(app_db, "icd-10-cm", "migrane")
    assert "G43.009" in {m.code for m in typo}
    billable, _ = await terms.search(app_db, "icd-10-cm", "diabetes", billable_only=True)
    assert all(m.billable for m in billable) and "E11" not in {m.code for m in billable}


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_pages_follow_on_without_repeats(loaded: None, app_db: Any) -> None:
    every, last = await terms.search(app_db, "icd-10-cm", "diabetes", limit=50)
    assert last is None
    seen: list[str] = []
    after = None
    while True:
        page, after = await terms.search(app_db, "icd-10-cm", "diabetes", after=after, limit=1)
        seen += [m.code for m in page]
        if after is None:
            break
    assert seen == [m.code for m in every]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_drug_search_gives_products_with_their_drug_details(loaded: None,
                                                                    app_db: Any) -> None:
    matches, _ = await terms.search(app_db, "rxnorm", "amoxicillin")
    assert matches and all(m.drug is not None for m in matches)
    amox = next(m for m in matches if m.code == "308191")
    assert amox.drug is not None and amox.drug.dose_form
    assert [i.rxcui for i in amox.drug.ingredients] == ["723"]
    assert amox.drug.ingredients[0].name.lower() == "amoxicillin"
    assert "723" not in {m.code for m in matches}  # an ingredient is not a product


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_a_system_with_nothing_loaded_answers_empty(loaded: None, app_db: Any) -> None:
    assert await terms.search(app_db, "cvx", "influenza") == ([], None)


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_the_code_system_records_the_release_and_its_licence(loaded: None,
                                                             admin_engine: Engine) -> None:
    with admin_engine.connect() as c:
        row = c.execute(text("SELECT version, license_note FROM admin.code_system "
                             "WHERE code = 'ICD10CM'")).one()
    assert row.version == "2025-10-01" and "public domain" in row.license_note
