"""The registry builds the same app as create_app() did before it (main.py at 2d4a897): the
same middleware stack in the same order, the same routes in matching order, the same error
handlers and the same app state, for an unconfigured, a development and a fully configured app.
`_legacy_app` is that create_app() body, copied once. A feature added after the registry adds
its own line there too ("added after the registry"), so the order stays checked. Synthetic
values only."""

import secrets
from typing import Any

import pytest
from fastapi import FastAPI
from pydantic import SecretStr

from app.core import (
    access_log,
    auth_api,
    backchannel,
    download_tokens,
    events,
    health,
    long_running,
    portal_auth_api,
    portal_sign_in,
    public_form,
    safe_logging,
)
from app.core.audit import AuditMiddleware
from app.core.config import Settings
from app.core.crypto import FieldCrypto
from app.core.db import Database
from app.core.errors import install_error_handlers
from app.core.idempotency import IdempotencyMiddleware, Replay, replay_response
from app.core.lifecycle import shut_down
from app.core.public_form import STATE as PUBLIC_FORM_GUARDS
from app.core.public_form import PublicFormGuards
from app.core.registry import FEATURES
from app.core.request_id import RequestIdMiddleware
from app.core.response_headers import NoStoreMiddleware
from app.core.routing import API_PREFIX, include_module_routers
from app.core.session import Keycloak, LoginStates
from app.main import create_app


@pytest.fixture(autouse=True)
def _no_settings_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only what each test passes: CI sets OPENBAO_TRANSIT_* for the encryption tests."""
    for field in Settings.model_fields:
        monkeypatch.delenv(field.upper(), raising=False)


def _legacy_app(settings: Settings) -> FastAPI:
    application = FastAPI(
        title="Shri Health API", version="0.1.0",
        docs_url=f"{API_PREFIX}/docs" if settings.show_docs else None, redoc_url=None,
        openapi_url=f"{API_PREFIX}/openapi.json" if settings.show_docs else None)
    application.state.settings = settings
    application.state.db = Database(settings) if settings.database_url else None
    application.state.crypto = FieldCrypto(settings) if settings.openbao_transit_addr else None
    application.state.public_db = (Database(settings, settings.public_database_url)
                                   if settings.public_database_url else None)
    setattr(application.state, PUBLIC_FORM_GUARDS,
            PublicFormGuards(settings)
            if settings.portal_origin or settings.public_form_secret else None)
    application.state.keycloak = Keycloak(settings) if settings.keycloak_public_url else None
    application.state.login_states = LoginStates()
    # Added after the registry:
    download_tokens.register(application, settings)
    access_log.register(application, settings)
    safe_logging.register(application, settings)
    backchannel.register(application, settings)
    portal_sign_in.register(application, settings)
    application.add_middleware(AuditMiddleware)
    application.add_middleware(IdempotencyMiddleware)
    application.add_middleware(NoStoreMiddleware)
    application.add_middleware(RequestIdMiddleware)
    install_error_handlers(application)
    application.add_exception_handler(Replay, replay_response)
    application.include_router(health.router)
    backchannel.register_routes(application, settings)  # added after the registry
    application.include_router(auth_api.router, prefix=API_PREFIX)
    public_form.include_routes(application, API_PREFIX)
    portal_auth_api.register(application, settings)  # added after the registry
    application.include_router(events.router, prefix=API_PREFIX)
    application.include_router(long_running.router, prefix=API_PREFIX)
    include_module_routers(application)
    return application


async def _close_legacy(application: FastAPI) -> None:
    for name in ("db", "public_db"):
        if getattr(application.state, name) is not None:
            await getattr(application.state, name).dispose()
    for name in ("crypto", "keycloak"):
        if getattr(application.state, name) is not None:
            await getattr(application.state, name).aclose()


def _secret() -> SecretStr:
    return SecretStr(secrets.token_hex(32))  # made at run time: no secret-like literal


def _bare() -> Settings:
    return Settings(environment="test")


def _development() -> Settings:
    return Settings(environment="development", auth_mode="dev_header",
                    patient_auth_mode="dev_header")


def _configured() -> Settings:
    db = "postgresql+asyncpg://app@db.example.test:5432/shri_health"
    return Settings(
        environment="test", database_url=db,
        public_database_url=db.replace("app@", "public@"),
        openbao_transit_addr="http://bao.example.test:8200", openbao_transit_token=_secret(),
        keycloak_public_url="https://portal.example.test/kc",
        keycloak_internal_url="http://keycloak.example.test:8080/kc",
        keycloak_client_secret=_secret(),
        keycloak_redirect_uri="https://portal.example.test/api/v1/auth/callback",
        session_secret=_secret(), portal_origin="https://portal.example.test",
        public_form_secret=_secret())


def _shape(application: FastAPI) -> dict[str, Any]:
    routes = []
    for route in application.router.routes:
        endpoint = getattr(route, "endpoint", None)
        routes.append((type(route).__name__, getattr(route, "path", None),
                       sorted(getattr(route, "methods", None) or ()),
                       getattr(endpoint, "__qualname__", None),
                       getattr(endpoint, "__module__", None)))
    state = application.state._state  # noqa: SLF001 (Starlette keeps app state here)
    return {
        "middleware": [(m.cls, m.kwargs) for m in application.user_middleware],
        "routes": routes,
        "exception handlers": list(application.exception_handlers),
        "state": {name: type(value).__name__ for name, value in state.items()
                  if name != "closers"},
        "docs": (application.docs_url, application.openapi_url, application.redoc_url),
    }


@pytest.mark.parametrize("settings", [_bare, _development, _configured],
                         ids=["bare", "development", "configured"])
async def test_the_registry_builds_the_same_app_as_before(settings: Any) -> None:
    before, after = _legacy_app(settings()), create_app(settings())
    try:
        old, new = _shape(before), _shape(after)
        for part in old:
            assert new[part] == old[part], part
        assert len(new["routes"]) > 10 and len(new["middleware"]) == 4
    finally:
        await _close_legacy(before)
        await shut_down(after)


async def test_shutdown_closes_every_client_the_registry_opened() -> None:
    application = create_app(_configured())
    opened = [application.state.db, application.state.public_db, application.state.crypto,
              application.state.keycloak, application.state.staff_realm_keys]
    assert all(opened) and len(application.state.closers) == len(opened)
    await shut_down(application)
    assert application.state.crypto._client.is_closed  # noqa: SLF001
    assert application.state.keycloak._client.is_closed  # noqa: SLF001


def test_an_unconfigured_app_has_nothing_to_close() -> None:
    assert getattr(create_app(_bare()).state, "closers", []) == []


def test_each_feature_is_listed_once_and_middleware_keeps_its_order() -> None:
    names = [name for name, _ in FEATURES]
    assert len(names) == len(set(names))
    assert names.index("audit") < names.index("idempotency") < names.index("no-store") \
        < names.index("request ID")
    assert names[-1] == "modules"


@pytest.mark.parametrize(("make", "named"), [
    (lambda: FieldCrypto(Settings(environment="test",
                                  openbao_transit_addr="http://bao.example.test:8200")),
     "OPENBAO_TRANSIT_TOKEN"),
    (lambda: Keycloak(Settings(environment="test",
                               keycloak_public_url="https://portal.example.test/kc")),
     "KEYCLOAK_INTERNAL_URL, KEYCLOAK_CLIENT_SECRET, KEYCLOAK_REDIRECT_URI"),
    (lambda: PublicFormGuards(Settings(environment="test",
                                       portal_origin="https://portal.example.test")),
     "PUBLIC_FORM_SECRET"),
])
def test_a_half_configured_feature_stops_startup_naming_what_to_set(make: Any,
                                                                      named: str) -> None:
    with pytest.raises(ValueError, match=f"not configured: set {named}$"):
        make()
