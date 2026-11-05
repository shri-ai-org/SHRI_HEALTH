"""The dry-run script's reporting (app.db.tools.demo_dry_run), without an API or a database: a
refused step names the call and the Problem code, never the values sent, and stops the steps
that need it."""
from __future__ import annotations

import httpx

from app.db.tools import demo_dry_run as dr

PATIENT = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def test_a_refused_step_names_the_call_and_stops_the_rest() -> None:
    registered: list[str] = []

    def api(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/patients/search"):
            return httpx.Response(200, json={"items": []})
        if path.endswith("/patients"):              # the person, then the same person again
            if registered:
                return httpx.Response(409, json={"code": "possible-duplicate"})
            registered.append(PATIENT)
            return httpx.Response(201, json={"id": PATIENT})
        return httpx.Response(422, json={
            "code": "business-rule-violation", "detail": "Dryrun123 born 1971-03-14",
            "errors": [{"pointer": "/startAt", "code": "out-of-range"}]})

    results = dr.run("http://api.test", httpx.MockTransport(api))
    assert [(n, ok) for n, ok, _ in results] == [(1, True)] + [(n, False) for n in range(2, 8)]
    assert results[1][2] == ("GET /booking/facilities answered 422 business-rule-violation "
                             "/startAt:out-of-range")
    assert all(reason == "not run: needs step 2" for _, _, reason in results[2:])
    assert not any("Dryrun123" in reason or "1971" in reason for _, _, reason in results)


def test_an_unreachable_api_is_a_failure_not_a_crash() -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    results = dr.run("http://api.test", httpx.MockTransport(down))
    assert results == [(1, False, "the API can't be reached: ConnectError")]
