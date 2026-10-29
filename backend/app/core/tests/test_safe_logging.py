"""Core logs failures without the values in them (core/safe_logging.py): a database error's
DETAIL can quote a row, so only the type, SQLSTATE, constraint and stack frames are logged.
Markers are made at run time; synthetic data only."""

import logging
import uuid

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from app.core.errors import install_error_handlers
from app.core.safe_logging import describe, log_failure
from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, sync_url

log = logging.getLogger("test.safe_logging")


def test_a_plain_failure_is_logged_by_type_and_frames_only(
        caplog: pytest.LogCaptureFixture) -> None:
    marker = f"SYNTHETIC-{uuid.uuid4().hex}"
    try:
        raise ValueError(f"bad value {marker}")
    except ValueError:
        with caplog.at_level(logging.ERROR):
            log_failure(log, "Something failed (request %s)", "req-1")
    assert marker not in caplog.text
    assert "builtins.ValueError" in caplog.text and "request req-1" in caplog.text
    assert "test_safe_logging.py" in caplog.text  # where it failed is still there


def test_causes_are_named_too() -> None:
    try:
        try:
            raise KeyError("inner SYNTHETIC")
        except KeyError as inner:
            raise RuntimeError("outer SYNTHETIC") from inner
    except RuntimeError as error:
        assert describe(error) == "builtins.RuntimeError <- builtins.KeyError"


def test_outside_an_except_block_only_the_message_is_logged(
        caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.ERROR):
        log_failure(log, "Nothing raised")
    assert caplog.records[-1].getMessage() == "Nothing raised"


@pytest.mark.db
@SKIP_WITHOUT_DATABASE
def test_a_database_errors_row_values_never_reach_the_log(
        caplog: pytest.LogCaptureFixture) -> None:
    marker = f"SYNTHETIC-{uuid.uuid4().hex}"
    engine = create_engine(sync_url(), poolclass=NullPool)
    try:
        with engine.connect() as c, pytest.raises(IntegrityError) as raised:
            c.execute(text("CREATE TEMP TABLE t (v text CONSTRAINT t_v_key UNIQUE)"))
            c.execute(text("INSERT INTO t VALUES (:v), (:v)"), {"v": marker})
        assert marker in str(raised.value)  # PostgreSQL quotes the row: the reason for this
        try:
            raise raised.value
        except IntegrityError:
            with caplog.at_level(logging.ERROR):
                log_failure(log, "Write failed")
    finally:
        engine.dispose()
    assert marker not in caplog.text
    assert "SQLSTATE 23505" in caplog.text and "constraint t_v_key" in caplog.text


def test_the_unhandled_error_handler_answers_500_without_logging_the_message(
        caplog: pytest.LogCaptureFixture) -> None:
    marker = f"SYNTHETIC-{uuid.uuid4().hex}"
    app = FastAPI()
    install_error_handlers(app)
    router = APIRouter()

    @router.get("/boom")
    async def boom() -> None:
        raise RuntimeError(f"row ({marker}) failed")

    app.include_router(router)
    with caplog.at_level(logging.ERROR):
        response = TestClient(app, raise_server_exceptions=False).get("/boom")
    assert response.status_code == 500 and response.json()["code"] == "internal-error"
    assert marker not in caplog.text and marker not in response.text
    assert "builtins.RuntimeError" in caplog.text and "Unhandled error on GET /boom" in caplog.text


def test_through_a_real_uvicorn_no_log_record_carries_the_exceptions_message(
        caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch) -> None:
    """Vimal's review of #144: Starlette re-raises after core's 500 handler, and uvicorn logs it
    on uvicorn.error ("Exception in ASGI application"). Every record from every logger, formatted
    with its traceback, must leave the exception's message out."""
    import threading
    import time

    import httpx
    import uvicorn

    from app.core.config import Settings
    from app.main import create_app

    for name in ("OPENBAO_TRANSIT_ADDR", "OPENBAO_TRANSIT_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    marker = f"SYNTHETIC-{uuid.uuid4().hex}"
    app = create_app(Settings(environment="test"))

    @app.get("/boom-for-test")  # outside /api/v1: not a contract route
    async def boom() -> None:
        raise ValueError(f"DETAIL: Key (family)=({marker}) already exists")

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=0, log_config=None,
                                           lifespan="off", access_log=True))
    thread = threading.Thread(target=server.run, daemon=True)
    with caplog.at_level(logging.DEBUG):
        thread.start()
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        port = server.servers[0].sockets[0].getsockname()[1]
        response = httpx.get(f"http://127.0.0.1:{port}/boom-for-test", timeout=5)
        server.should_exit = True
        thread.join(5)
    assert response.status_code == 500 and marker not in response.text
    formatter = logging.Formatter("%(name)s %(message)s")
    texts = [formatter.format(record) for record in caplog.records]
    assert any(t.startswith("uvicorn.error Exception in ASGI application") for t in texts), texts
    assert any("builtins.ValueError" in t for t in texts)  # what failed is still logged
    assert not [t for t in texts if marker in t]
