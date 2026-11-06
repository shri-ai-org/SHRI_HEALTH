"""Shri Health API: FHIR R4 facade (clinical) + admin CRUD (practice management)."""
from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError

from shri.api.admin import admin_router
from shri.api.fhir import router as fhir_router

app = FastAPI(title="Shri Health API", version="0.1.0",
              description="FHIR R4 / US Core facade over the clinical record and typed "
                          "endpoints for practice administration.")
app.include_router(fhir_router)
app.include_router(admin_router())

# PostgreSQL SQLSTATE -> HTTP status for errors raised by constraints, triggers and RLS.
SQLSTATE_HTTP = {
    "23505": 409,   # unique_violation
    "23503": 409,   # foreign_key_violation (incl. tenant / same-patient composite FKs)
    "23514": 422,   # check_violation (FHIR invariants, value sets)
    "23502": 422,   # not_null_violation
    "23P01": 409,   # exclusion_violation (double booking)
    "P0001": 422,   # raise_exception from a safety rule trigger
    "42501": 403,   # insufficient_privilege / row-level security
}


@app.exception_handler(DBAPIError)
async def db_error(request: Request, exc: DBAPIError) -> JSONResponse:
    orig = exc.orig
    state = getattr(orig, "sqlstate", None)
    status = SQLSTATE_HTTP.get(state, 500)
    diag = getattr(orig, "diag", None)
    detail = {"sqlstate": state,
              "constraint": getattr(diag, "constraint_name", None),
              "message": getattr(diag, "message_primary", None) if status != 500 else
              "database error"}
    return JSONResponse({"resourceType": "OperationOutcome", "issue": [{
        "severity": "error", "code": "conflict" if status == 409 else
        "forbidden" if status == 403 else "invariant" if status == 422 else "exception",
        "diagnostics": detail["message"], "expression": [detail["constraint"]] if
        detail["constraint"] else None}]}, status_code=status)


@app.get("/health", tags=["ops"])
async def health() -> dict:
    return {"status": "ok"}
