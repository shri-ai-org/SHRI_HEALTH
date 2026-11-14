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


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_full_release_loads_over_the_bind_parameter_limit(admin_engine: Engine) -> None:
    """A full FY release has about 97,000 codes: the retirement check anti-joins a temporary
    table instead of a NOT IN list, so it never builds a statement with one bind parameter per
    code (over PostgreSQL's 65,535 limit)."""
    engine = create_engine(sync_url(), poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def _as_migrator(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()

    # The module's `loaded` fixture may have already put a handful of ICD-10-CM codes in
    # (ORDER_FILE); this release retires whichever of those this release doesn't repeat, so
    # `retired` isn't asserted here.
    many = [icd10cm.Code(f"Z{n:05d}", f"Synthetic code {n}", True) for n in range(70_000)]
    with Session(engine) as db, db.begin():
        counts = icd10cm.load(db, many, date(2025, 10, 1))
    assert counts["concepts"] == 70_000 and counts["billable"] == 70_000

    # A second release dropping half the codes retires exactly those, again over the limit.
    kept = many[:35_000]
    with Session(engine) as db, db.begin():
        counts = icd10cm.load(db, kept, date(2026, 10, 1))
    assert counts == {"concepts": 35_000, "billable": 35_000, "retired": 35_000}
    with admin_engine.connect() as c:
        still_active = c.execute(text(
            "SELECT count(*) FROM admin.concept c JOIN admin.code_system s "
            "ON s.id = c.code_system_id WHERE s.code = 'ICD10CM' AND c.is_active")).scalar_one()
    assert still_active == 35_000
    engine.dispose()


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
async def test_equal_matches_put_the_shorter_name_first(loaded: None, app_db: Any) -> None:
    """Within a class and a similarity, the shorter name comes first, before the code: a single
    product before a combination pack that contains it ("amoxicillin 500" on the real RxNorm
    release listed packs first). Here a later code with a shorter name."""
    extra = _line(7, "Z8669", True, "Personal history of migraine")
    _load_as_migrator(ORDER_FILE + [extra])
    try:
        matches, _ = await terms.search(app_db, "icd-10-cm", "migraine")
        assert [m.code for m in matches] == ["G43", "Z86.69", "G43.009"]
        pages, after, seen = 0, None, []
        while True:                     # the keyset cursor follows the same order
            page, after = await terms.search(app_db, "icd-10-cm", "migraine", after=after, limit=1)
            seen += [m.code for m in page]
            pages += 1
            if after is None:
                break
        assert seen == ["G43", "Z86.69", "G43.009"] and pages == 3
    finally:
        _load_as_migrator(ORDER_FILE)   # the extra code is retired again


#: Audit V3: names that contain "essential hypertension" word for word but say much more.
HYPERTENSION = [
    _line(8, "I159", True, "Secondary hypertension, unspecified"),
    _line(9, "O1002", True, "Pre-existing essential hypertension complicating childbirth"),
    _line(10, "O1003", True, "Pre-existing essential hypertension complicating the puerperium"),
    _line(11, "O10011", True,
          "Pre-existing essential hypertension complicating pregnancy, first trimester"),
    _line(12, "R030", True, "Elevated blood-pressure reading, without diagnosis of hypertension"),
]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_the_general_name_comes_before_longer_ones_with_the_phrase(loaded: None,
                                                                         app_db: Any) -> None:
    """Within a class the whole name's similarity decides, so every extra word counts against a
    name: I10 first for "essential hypertension" and for "hypertension", where the pregnancy
    codes, which contain the phrase word for word, used to come first. Pages follow the same
    order, without repeats or gaps."""
    _load_as_migrator(ORDER_FILE + HYPERTENSION)
    try:
        for q in ("essential hypertension", "hypertension", "Essential  HYPERTENSION"):
            every, last = await terms.search(app_db, "icd-10-cm", q, limit=50)
            codes = [m.code for m in every]
            assert last is None and codes[0] == "I10", (q, codes)
            assert codes.index("I10") < min(codes.index(c) for c in codes if c.startswith("O10"))
            seen, after = [], None
            while True:
                page, after = await terms.search(app_db, "icd-10-cm", q, after=after, limit=2)
                seen += [m.code for m in page]
                if after is None:
                    break
            assert seen == codes and len(set(seen)) == len(seen)
        broad, _ = await terms.search(app_db, "icd-10-cm", "hypertension", limit=50)
        assert [m.code for m in broad][:2] == ["I10", "I15.9"]
    finally:
        _load_as_migrator(ORDER_FILE)   # the extra codes are retired again


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_drug_search_keeps_its_word_similarity(loaded: None, app_db: Any) -> None:
    """The V3 change is for code systems other than RxNorm: a drug's score is still the best
    matching part of its name, so a product's order doesn't move."""
    matches, _ = await terms.search(app_db, "rxnorm", "amoxicillin 500")
    assert matches
    best = matches[0].position
    assert best.rank == 2 and best.similarity == pytest.approx(1.0)


#: Audit V3: names the typed words alone don't reach ("COPD", "breast cancer").
SYNONYM_CODES = HYPERTENSION + [
    _line(13, "J449", True, "Chronic obstructive pulmonary disease, unspecified"),
    _line(14, "C50919", True,
          "Malignant neoplasm of unspecified site of unspecified female breast"),
    _line(15, "Z853", True, "Personal history of malignant neoplasm of breast"),
]


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
async def test_a_synonym_finds_what_the_typed_words_alone_do_not(loaded: None,
                                                                 app_db: Any) -> None:
    """The codes module's synonym (``also``) is searched beside the query: COPD finds J44.9,
    "hypertension" with I10's wording puts I10 first, and pages follow the same order."""
    _load_as_migrator(ORDER_FILE + SYNONYM_CODES)
    try:
        bare, _ = await terms.search(app_db, "icd-10-cm", "copd", limit=50)
        assert "J44.9" not in {m.code for m in bare}
        copd, _ = await terms.search(app_db, "icd-10-cm", "COPD",
                                     also="chronic obstructive pulmonary disease", limit=50)
        assert copd[0].code == "J44.9"
        cancer, _ = await terms.search(app_db, "icd-10-cm", "breast cancer",
                                       also="malignant neoplasm of breast", limit=50)
        assert [m.code for m in cancer][:2] == ["C50.919", "Z85.3"] or \
            [m.code for m in cancer][:2] == ["Z85.3", "C50.919"]
        every, _ = await terms.search(app_db, "icd-10-cm", "hypertension",
                                      also="essential (primary) hypertension", limit=50)
        codes = [m.code for m in every]
        assert codes[0] == "I10" and {"I15.9", "O10.02"} <= set(codes)
        seen, after = [], None
        while True:
            page, after = await terms.search(app_db, "icd-10-cm", "hypertension",
                                             also="essential (primary) hypertension",
                                             after=after, limit=2)
            seen += [m.code for m in page]
            if after is None:
                break
        assert seen == codes and len(set(seen)) == len(seen)
        drugs, _ = await terms.search(app_db, "rxnorm", "amoxicillin 500", also="ignored")
        plain, _ = await terms.search(app_db, "rxnorm", "amoxicillin 500")
        assert [m.code for m in drugs] == [m.code for m in plain]   # drugs never expand
    finally:
        _load_as_migrator(ORDER_FILE)


def _load_as_migrator(lines: list[str]) -> None:
    engine = create_engine(sync_url(), poolclass=NullPool)

    @event.listens_for(engine, "connect")
    def _as_migrator(dbapi_connection: Any, _record: Any) -> None:
        cursor = dbapi_connection.cursor()
        cursor.execute("SET ROLE shri_migrator")
        cursor.close()
        dbapi_connection.commit()

    with Session(engine) as db, db.begin():
        icd10cm.load(db, list(icd10cm.read_order_file(lines)), date(2025, 10, 1))
    engine.dispose()


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
