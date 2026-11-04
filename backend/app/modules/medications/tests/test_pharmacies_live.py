"""The pharmacy directory (listPharmacies, D50) against a live database, as shri_app with core's
tenant_db: the name search (wildcards typed by the user match themselves), the ZIP code (a
5-digit ZIP also finds a stored ZIP+4), mail order, the order by name, and that nothing is
audited. The directory is platform data shared by every test, so each test's rows carry a name
token and ZIP codes of their own. Synthetic data only.
"""
# ruff: noqa: F811 (scheduling's live fixtures are parameters here)
from __future__ import annotations

import random
import uuid
from typing import Any

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool

from app.db.tests.conftest import TEST_DATABASE_URL, sync_url
from app.modules.scheduling.tests.conftest import (  # noqa: F401 (fixtures)
    Practice,
    client,
    practice,
    setup_session,
    users,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not TEST_DATABASE_URL, reason="needs a test database"),
]

API = "/api/v1/pharmacies"


def _directory(token: str, zip_a: str, zip_b: str) -> dict[str, str]:
    """Four synthetic pharmacies named after `token`; their IDs by short name."""
    rows = {"town": (f"{token} Town Pharmacy", zip_a, False, True, "300 Test Road"),
            "plus4": (f"{token} Corner Drug", f"{zip_a}-1234", False, True, None),
            "mail": (f"{token} Mail Order", zip_b, True, True, None),
            "odd": (f"{token} 50%_Off Pharmacy", zip_b, False, False, None)}
    ids: dict[str, str] = {}
    admin = create_engine(sync_url(), poolclass=NullPool)
    with admin.begin() as c:
        for key, (name, postal, mail, active, line) in rows.items():
            ids[key] = str(uuid.uuid4())
            c.execute(text(
                "INSERT INTO admin.pharmacy (id, ncpdp_id, name, address_line, city, state, "
                "postal_code, is_mail_order, is_active) VALUES (:i, :n, :name, :line, :city, "
                ":state, :zip, :mail, :active)"),
                {"i": ids[key], "n": f"{uuid.uuid4().int % 10**7:07d}", "name": name,
                 "line": line, "city": line and "Springfield", "state": line and "IL",
                 "zip": postal, "mail": mail, "active": active})
    admin.dispose()
    return ids


@pytest.fixture
def directory() -> tuple[str, str, str, dict[str, str]]:
    token = f"Synth{uuid.uuid4().hex[:8]}"
    zip_a, zip_b = (f"{n:05d}" for n in random.sample(range(10_000, 99_999), 2))
    return token, zip_a, zip_b, _directory(token, zip_a, zip_b)


def _ids(response: Any) -> list[str]:
    assert response.status_code == 200, response.text
    return [i["id"] for i in response.json()["items"]]


def test_search_by_name_zip_and_mail_order(client: Any, practice: Practice,
                                           directory: tuple[str, str, str, dict[str, str]]
                                           ) -> None:
    token, zip_a, zip_b, ids = directory
    by_name = client("fd").get(API, params={"q": token.lower()})  # case-insensitive
    assert _ids(by_name) == [ids["odd"], ids["plus4"], ids["mail"], ids["town"]]  # by name
    town = next(i for i in by_name.json()["items"] if i["id"] == ids["town"])
    assert town["address"] == {"line": "300 Test Road", "city": "Springfield", "state": "IL",
                               "postalCode": zip_a}
    mail = next(i for i in by_name.json()["items"] if i["id"] == ids["mail"])
    assert mail["address"] == {"postalCode": zip_b}  # only what the directory has
    assert _ids(client("md").get(API, params={"q": token, "postalCode": zip_a})) == [ids["plus4"],
                                                                          ids["town"]]
    assert _ids(client("ma").get(API, params={"q": token, "mailOrder": "true"})) == [ids["mail"]]
    assert _ids(client("rn").get(API, params={"q": token, "postalCode": zip_b,
                                              "mailOrder": "false"})) == [ids["odd"]]


def test_typed_wildcards_match_themselves(client: Any, practice: Practice,
                                          directory: tuple[str, str, str, dict[str, str]]
                                          ) -> None:
    token, _, _, ids = directory
    assert _ids(client("fd").get(API, params={"q": f"{token} 50%_Off"})) == [ids["odd"]]
    assert _ids(client("fd").get(API, params={"q": f"{token} %"})) == []
    assert _ids(client("fd").get(API, params={"q": f"{token}_"})) == []


def test_pages_and_nothing_is_audited(client: Any, practice: Practice,
                                      directory: tuple[str, str, str, dict[str, str]]) -> None:
    token, _, _, ids = directory
    admin = create_engine(sync_url(), poolclass=NullPool)

    def audited() -> int:
        with admin.connect() as c:
            found: int = c.execute(text("SELECT count(*) FROM audit.audit_event WHERE "
                                        "tenant_id = :t"), {"t": practice.clinic}).scalar_one()
            return found

    before = audited()
    first = client("fd").get(API, params={"q": token, "limit": 3})
    second = client("fd").get(API, params={"q": token, "limit": 3,
                                           "cursor": first.json()["nextCursor"]})
    assert _ids(first) + _ids(second) == [ids["odd"], ids["plus4"], ids["mail"], ids["town"]]
    assert "nextCursor" not in second.json()
    assert audited() == before  # reference data: x-audit category none
    admin.dispose()


def test_refused_without_the_permission(client: Any, practice: Practice) -> None:
    response = client("bil").get(API, params={"q": "pharmacy"})
    assert response.status_code == 403
    assert response.json()["code"] == "permission-denied"
