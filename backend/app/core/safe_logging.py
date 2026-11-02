"""Logging a failure without the values in it.

`log.exception()` writes the exception's message, and a database error's message can quote the
row: PostgreSQL's `DETAIL: Key (column)=(value) already exists`, a check constraint's failing
row, a bad value in a cast. Those values may be patient data, which never goes in a log
(CLAUDE.md). So core logs a failure as its type, its SQLSTATE and constraint name when it has
them, and the stack frames (file, line, function and source line), but never the message:

    except Exception:
        log_failure(log, "Audit write failed; the request fails (request %s)", request_id)

The request ID in the line links it to the audit trail, where the details that are safe to keep
are.
"""

import logging
import sys
import traceback
from types import TracebackType
from typing import Any

from fastapi import FastAPI

from app.core.config import Settings

# uvicorn logs an exception that reaches the server ("Exception in ASGI application") with its
# message; Starlette re-raises after core's 500 handler so that it does (Vimal's review of #144).
SERVER_ERROR_LOGGER = "uvicorn.error"


def _sqlstate(error: BaseException) -> tuple[str | None, str | None]:
    """(SQLSTATE, constraint name) of a database error, from SQLAlchemy's wrapper or the
    driver's own exception; (None, None) for anything else."""
    for candidate in (error, getattr(error, "orig", None)):
        if candidate is None:
            continue
        state = getattr(candidate, "sqlstate", None) or getattr(candidate, "pgcode", None)
        diag = getattr(candidate, "diag", None)
        constraint = getattr(diag, "constraint_name", None) if diag is not None else None
        if state or constraint:
            return (str(state) if state else None, str(constraint) if constraint else None)
    return None, None


def describe(error: BaseException) -> str:
    """The error's type, with its SQLSTATE and constraint when it has them, and its causes the
    same way; never a message."""
    parts = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        state, constraint = _sqlstate(current)
        name = f"{type(current).__module__}.{type(current).__qualname__}"
        extra = ", ".join(f"{k} {v}" for k, v in (("SQLSTATE", state),
                                                   ("constraint", constraint)) if v)
        parts.append(f"{name} ({extra})" if extra else name)
        current = current.__cause__ or current.__context__
    return " <- ".join(parts)


def _frames(tb: TracebackType | None) -> str:
    return "".join(traceback.format_tb(tb)).rstrip()


def log_failure(logger: logging.Logger, message: str, *args: Any) -> None:
    """In an `except` block: `message` at ERROR, with what failed and where, never the
    exception's message. Outside one, just `message`."""
    error = sys.exc_info()[1]
    if error is None:
        logger.error(message, *args)
        return
    logger.error(message + "\n%s\nTraceback (values left out):\n%s", *args, describe(error),
                 _frames(error.__traceback__))


class DropExceptionMessages(logging.Filter):
    """On a logger we don't call ourselves (uvicorn.error): a record carrying an exception keeps
    its own message and gains what failed and where (describe() and the frames), but never the
    exception's message, which may quote a row."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info and record.exc_info[1] is not None:
            error = record.exc_info[1]
            record.msg = (f"{record.getMessage()}\n{describe(error)}\n"
                          f"Traceback (values left out):\n{_frames(error.__traceback__)}")
            record.args = None
            record.exc_info = None
            record.exc_text = None
        return True


def register(app: FastAPI, settings: Settings) -> None:
    logger = logging.getLogger(SERVER_ERROR_LOGGER)
    if not any(isinstance(f, DropExceptionMessages) for f in logger.filters):
        logger.addFilter(DropExceptionMessages())
