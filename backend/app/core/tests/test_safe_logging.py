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
