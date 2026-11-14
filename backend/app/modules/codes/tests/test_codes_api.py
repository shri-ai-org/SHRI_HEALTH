"""searchCodes through the API (GET /codes): a success, the permission refusal, the
contract's validation and the cursor. The search is stubbed; app/db/tests/test_code_search.py
runs it on a real database. Synthetic data only."""
from __future__ import annotations

import base64
import json
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.deps import CurrentUser, current_user, tenant_db
from app.core.errors import InvalidCursor
from app.db.terminology import search as terms
from app.main import create_app

from .. import service

ICD = terms.Match(system="http://hl7.org/fhir/sid/icd-10-cm", code="I10",
                  display="Essential (primary) hypertension", billable=True, drug=None,
                  position=terms.Position(0, 1.0, 32, "I10"))
RX = terms.Match(system="http://www.nlm.nih.gov/research/umls/rxnorm", code="308191",
                 display="amoxicillin 500 MG Oral Capsule", billable=None,
                 drug=terms.Drug(strength="500 MG", dose_form="Oral Capsule", route="Oral",
                                 ingredients=(terms.Ingredient("723", "amoxicillin"),),
                                 brand_name=None, schedule=None),
                 position=terms.Position(2, 0.9, 37, "308191"))


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    seen: list[dict[str, Any]] = []

    async def fake(db: Any, system: str, q: str, **kw: Any) -> Any:
        seen.append({"system": system, "q": q, **kw})
        match = RX if system == "rxnorm" else ICD
        return [match], (match.position if q == "more" else None)

    monkeypatch.setattr(terms, "search", fake)
    return seen


@pytest.fixture
def client() -> TestClient:
    app = create_app(Settings(environment="test", auth_mode="dev_header"))

    async def no_db(user: CurrentUser = __import__("fastapi").Depends(current_user)) -> None:
        return None

    app.dependency_overrides[tenant_db] = no_db
    return TestClient(app, raise_server_exceptions=False)


def _get(client: TestClient, user: str, **params: Any) -> Any:
    return client.get("/api/v1/codes", params=params, headers={"X-Dev-User": user})


def test_icd10_search_in_the_contracts_shape(client: TestClient,
                                              calls: list[dict[str, Any]]) -> None:
    response = _get(client, "md", system="icd-10-cm", q="hypertension", billableOnly="true")
    assert response.status_code == 200, response.text
    assert response.json() == {"items": [{
        "system": "http://hl7.org/fhir/sid/icd-10-cm", "code": "I10",
        "display": "Essential (primary) hypertension", "billable": True}]}
    assert calls[0]["billable_only"] is True and calls[0]["limit"] == 25


def test_drug_search_carries_the_drug(client: TestClient, calls: list[dict[str, Any]]) -> None:
    item = _get(client, "md", system="rxnorm", q="amox").json()["items"][0]
    assert item["drug"] == {"strength": "500 MG", "doseForm": "Oral Capsule", "route": "Oral",
                            "ingredients": [{"rxcui": "723", "name": "amoxicillin"}]}
    assert "billable" not in item


def test_the_cursor_continues_only_the_same_search(client: TestClient,
                                                   calls: list[dict[str, Any]]) -> None:
    first = _get(client, "md", system="icd-10-cm", q="more").json()
    cursor = first["nextCursor"]
    assert _get(client, "md", system="icd-10-cm", q="more", cursor=cursor).status_code == 200
    assert calls[-1]["after"] == ICD.position
    other = _get(client, "md", system="icd-10-cm", q="other words", cursor=cursor)
    assert other.status_code == 400 and other.json()["code"] == "invalid-cursor"
    assert _get(client, "md", system="icd-10-cm", q="more",
                cursor="bm90LWEtY3Vyc29y").status_code == 400


@pytest.mark.parametrize("name", ["none", "dsp"])
def test_codes_read_is_required(client: TestClient, calls: list[dict[str, Any]],
                                name: str) -> None:
    response = _get(client, name, system="icd-10-cm", q="hy")
    assert response.status_code == 403 and response.json()["code"] == "permission-denied"
    assert not calls


@pytest.mark.parametrize("params", [
    {"system": "icd-10-cm", "q": "h"}, {"system": "icd10", "q": "hy"}, {"q": "hy"},
    {"system": "icd-10-cm"}, {"system": "icd-10-cm", "q": "hy", "limit": "101"}])
def test_invalid_parameters(client: TestClient, calls: list[dict[str, Any]],
                            params: dict[str, str]) -> None:
    response = _get(client, "md", **params)
    assert response.status_code == 422 and response.json()["code"] == "validation-failed"


def test_fingerprint_ignores_spacing_and_case() -> None:
    assert service.fingerprint("rxnorm", "Amox  500", False) == service.fingerprint(
        "rxnorm", "amox 500", False)


def test_a_cursor_from_before_the_v3_ranking_is_refused() -> None:
    """Version 3 changed the ICD-10-CM score (audit V3); an older cursor would continue a
    different order, so it is refused (400 invalid-cursor) and the client starts again."""
    finger = service.fingerprint("icd-10-cm", "hypertension", False)
    position = terms.Position(2, 0.42, 32, "I10")
    assert service.decode(service.encode(position, finger), finger) == position
    old = base64.urlsafe_b64encode(json.dumps(
        {"v": 2, "f": finger, "r": 2, "s": 0.42, "n": 32, "c": "I10"},
        separators=(",", ":")).encode()).rstrip(b"=").decode()
    with pytest.raises(InvalidCursor):
        service.decode(old, finger)


def test_a_synonym_is_searched_beside_the_typed_words(client: TestClient,
                                                      calls: list[dict[str, Any]]) -> None:
    assert _get(client, "md", system="icd-10-cm", q="  COPD ").status_code == 200
    assert calls[-1]["q"] == "  COPD "
    assert calls[-1]["also"] == "chronic obstructive pulmonary disease"
    assert _get(client, "md", system="icd-10-cm", q="copd exacerbation").status_code == 200
    assert calls[-1]["also"] is None                       # only the whole query expands
    assert _get(client, "md", system="rxnorm", q="flu").status_code == 200
    assert calls[-1]["also"] is None                       # drugs never expand
