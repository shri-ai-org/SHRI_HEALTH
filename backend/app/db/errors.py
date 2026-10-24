"""Maps a PostgreSQL SQLSTATE (from a constraint, trigger or RLS violation) to the HTTP status
and diagnostic detail an API layer should return.

Deliberately format-agnostic: ``backend/app/fhir/api.py`` wraps this in an OperationOutcome
(D22 - ``/fhir`` keeps FHIR's own error shape); every other endpoint wraps it in Problem Details
(Thulasi's ``backend/app/core/errors.py``, D21/D3) instead. Neither format is produced here, so
this module has no FastAPI dependency and no opinion about which one a caller uses.
"""
from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.exc import DBAPIError

#: PostgreSQL SQLSTATE -> HTTP status for errors raised by constraints, triggers and RLS.
SQLSTATE_HTTP = {
    "23505": 409,   # unique_violation
    "23503": 409,   # foreign_key_violation (incl. tenant / same-patient composite FKs)
    "23514": 422,   # check_violation (FHIR invariants, value sets)
    "23502": 422,   # not_null_violation
    "23P01": 409,   # exclusion_violation (double booking)
    "P0001": 422,   # raise_exception from a safety rule trigger
    "42501": 403,   # insufficient_privilege / row-level security
}


@dataclass(frozen=True)
class DbErrorDetail:
    status: int
    sqlstate: str | None
    constraint: str | None
    message: str | None    # None on a 500: don't leak internals past "database error"


def db_error_detail(exc: DBAPIError) -> DbErrorDetail:
    orig = exc.orig
    state = getattr(orig, "sqlstate", None)
    status = SQLSTATE_HTTP.get(state, 500) if isinstance(state, str) else 500
    diag = getattr(orig, "diag", None)
    return DbErrorDetail(
        status=status,
        sqlstate=state,
        constraint=getattr(diag, "constraint_name", None),
        message=getattr(diag, "message_primary", None) if status != 500 else "database error",
    )
