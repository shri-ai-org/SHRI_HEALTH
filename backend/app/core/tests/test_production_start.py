"""In production the API refuses to start without OpenBao Transit (crypto.check_production, run
by main.lifespan): sessions, idempotent replays and files would otherwise fail request by request.
Other environments start as before. The error names what to set, never a value."""

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings
from app.main import create_app

TOKEN = "s.synthetic-transit-token-for-tests"  # noqa: S105 (not a real token)


@pytest.fixture(autouse=True)
def _no_transit_in_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only what each test passes counts, not the OpenBao the suite may run with."""
    for name in ("OPENBAO_ADDR", "OPENBAO_TRANSIT_ADDR", "OPENBAO_TRANSIT_TOKEN"):
        monkeypatch.delenv(name, raising=False)


def _settings(**values: object) -> Settings:
    return Settings(auth_mode="keycloak", **values)  # type: ignore[arg-type]


@pytest.mark.parametrize("values", [
    {},
    {"openbao_transit_token": SecretStr(TOKEN)},
])
def test_production_without_transit_refuses_to_start(values: dict[str, object]) -> None:
    app = create_app(_settings(environment="production", **values))
    with pytest.raises(RuntimeError, match="without OpenBao Transit") as refused:
        with TestClient(app):
            pass
    assert "OPENBAO_TRANSIT" in str(refused.value) and TOKEN not in str(refused.value)


def test_an_address_without_a_token_already_fails_when_the_app_is_built() -> None:
    with pytest.raises(ValueError, match="OPENBAO_TRANSIT_TOKEN"):
        create_app(_settings(environment="production",
                             openbao_transit_addr="http://openbao.test:8200"))


def test_production_with_transit_starts() -> None:
    app = create_app(_settings(environment="production",
                               openbao_transit_addr="http://openbao.test:8200",
                               openbao_transit_token=SecretStr(TOKEN)))
    with TestClient(app) as client:
        assert client.get("/health").status_code == 200


@pytest.mark.parametrize("environment", ["development", "test", "staging"])
def test_other_environments_start_without_it(environment: str) -> None:
    with TestClient(create_app(_settings(environment=environment))) as client:
        assert client.get("/health").status_code == 200
