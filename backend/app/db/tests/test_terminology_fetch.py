"""Fetching and loading the pinned code releases (app.db.terminology.fetch, ``python -m
app.db.terminology all``) on small fixture releases: the ICD-10-CM order lines of
test_code_search and test_rxnorm's RxNorm sample, zipped as CMS and NLM ship them. No network:
downloads go through a fake transport."""
from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from sqlalchemy import Engine, create_engine, event, text
from sqlalchemy.pool import NullPool

from app.db.terminology import __main__ as terminology
from app.db.terminology import fetch
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, sync_url
from app.db.tests.test_code_search import ORDER_FILE
from app.db.tests.test_rxnorm import DATA


def _zip(path: Path, members: dict[str, bytes]) -> fetch.Pinned:
    with zipfile.ZipFile(path, "w") as z:
        for name, data in members.items():
            z.writestr(name, data)
    return fetch.Pinned(f"https://releases.test/{path.name}", path.name,
                        hashlib.sha256(path.read_bytes()).hexdigest())


@pytest.fixture
def releases(tmp_path: Path) -> dict[str, Any]:
    """The two fixture releases (served from ``served/``) and their pins."""
    served = tmp_path / "served"
    served.mkdir()
    codes = _zip(served / "2026-code-descriptions-tabular-order.zip",
                 {fetch.ICD10CM_MEMBER: "\n".join(ORDER_FILE).encode("latin-1")})
    drugs = _zip(served / "RxNorm_full_prescribe_10052026.zip",
                 {f"rrf/{f.name}": f.read_bytes() for f in DATA.iterdir()})
    return {"served": served, "codes": codes, "drugs": drugs, "cache": tmp_path / "cache"}


def _server(served: Path, calls: list[str]) -> httpx.MockTransport:
    def answer(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, content=(served / request.url.path.lstrip("/")).read_bytes())
    return httpx.MockTransport(answer)


def test_a_release_is_downloaded_once_then_read_from_the_cache(releases: dict[str, Any]
                                                               ) -> None:
    calls: list[str] = []
    first = fetch.fetch(releases["codes"], releases["cache"], _server(releases["served"], calls))
    again = fetch.fetch(releases["codes"], releases["cache"], _server(releases["served"], calls))
    assert first == again == releases["cache"] / releases["codes"].file_name
    assert calls == ["/2026-code-descriptions-tabular-order.zip"]       # once
    year, codes = fetch.icd10cm_codes(first)
    assert year == 2026 and [c.code for c in codes][:2] == ["E11", "E11.9"]


def test_a_file_that_isnt_the_pinned_release_is_refused_and_never_cached(
        releases: dict[str, Any]) -> None:
    wrong = fetch.Pinned(releases["codes"].url, releases["codes"].file_name, "0" * 64)
    with pytest.raises(fetch.ChecksumMismatch):
        fetch.fetch(wrong, releases["cache"], _server(releases["served"], []))
    assert list(releases["cache"].iterdir()) == []                      # no file, no .part
    cached = releases["cache"] / releases["codes"].file_name
    cached.write_bytes(b"tampered")                                     # a changed cache file
    path = fetch.fetch(releases["codes"], releases["cache"], _server(releases["served"], []))
    assert hashlib.sha256(path.read_bytes()).hexdigest() == releases["codes"].sha256


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_one_command_loads_both_and_a_second_run_changes_nothing(
        releases: dict[str, Any], monkeypatch: pytest.MonkeyPatch, admin_engine: Engine) -> None:
    for pinned in (releases["codes"], releases["drugs"]):               # already cached
        fetch.fetch(pinned, releases["cache"], _server(releases["served"], []))
    monkeypatch.setenv(fetch.CACHE_ENV, str(releases["cache"]))
    monkeypatch.setattr(fetch, "ICD10CM", releases["codes"])
    monkeypatch.setattr(fetch, "RXNORM", releases["drugs"])

    def offline(*_: Any, **__: Any) -> None:
        raise AssertionError("the cached releases need no download")
    monkeypatch.setattr(httpx.Client, "stream", offline)

    def migrator() -> Engine:                    # as MIGRATION_DATABASE_URL's shri_migrator
        engine = create_engine(sync_url(), poolclass=NullPool)

        @event.listens_for(engine, "connect")
        def _as_migrator(dbapi_connection: Any, _record: Any) -> None:
            cursor = dbapi_connection.cursor()
            cursor.execute("SET ROLE shri_migrator")
            cursor.close()
            dbapi_connection.commit()
        return engine
    monkeypatch.setattr(terminology, "_engine", migrator)

    def stored() -> list[Any]:
        with admin_engine.connect() as c:
            return list(c.execute(text(
                "SELECT s.code AS system, c.code, c.display, c.is_active FROM admin.concept c "
                "JOIN admin.code_system s ON s.id = c.code_system_id "
                "WHERE s.code IN ('ICD10CM', 'RXNORM') AND c.is_active ORDER BY 1, 2")))

    assert terminology.main(["all"]) == 0
    first = stored()
    assert {r.system for r in first} == {"ICD10CM", "RXNORM"}
    assert ("ICD10CM", "E11.9") in {(r.system, r.code) for r in first}
    assert terminology.main(["all"]) == 0
    assert stored() == first
