"""The stand-in helper: a stand-in route wins over a real route mounted before it."""

from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from app.core.tests.stand_ins import include_first


async def _real() -> dict[str, str]:
    return {"from": "real"}


async def _stand_in() -> dict[str, str]:
    return {"from": "stand-in"}


def test_a_stand_in_wins_over_a_route_mounted_before_it() -> None:
    app = FastAPI()
    real, stand_in = APIRouter(), APIRouter()
    real.add_api_route("/patients/{patientId}", _real)
    stand_in.add_api_route("/patients/{patientId}", _stand_in)
    app.include_router(real, prefix="/api/v1")
    include_first(app, stand_in, prefix="/api/v1")
    assert TestClient(app).get("/api/v1/patients/x").json() == {"from": "stand-in"}


def test_plain_include_router_would_reach_the_real_route() -> None:
    """Why the helper exists: Starlette serves the first route that matches."""
    app = FastAPI()
    real, stand_in = APIRouter(), APIRouter()
    real.add_api_route("/patients/{patientId}", _real)
    stand_in.add_api_route("/patients/{patientId}", _stand_in)
    app.include_router(real, prefix="/api/v1")
    app.include_router(stand_in, prefix="/api/v1")
    assert TestClient(app).get("/api/v1/patients/x").json() == {"from": "real"}
