"""FHIR R4 facade over the application database (ADR-19, ADR-0011 condition 3): read, vread,
history, POST _search and the CapabilityStatement. Read-only - writes go through the domain
endpoints (sign, order, ...) under /api/v1, not generic FHIR create/update, so the clinical
safety rules stay in one place. Every read is audited. Restricted charts (meta.security R / V)
are never served here, grant or not (D22): the database hides them from ``shri_fhir_reader``
(migration 0006), and a request for one gets the same 404 as a request for an ID that does not
exist. Break-glass is an /api/v1 concern (D37).

Access is machine-token only (ADR-0011 condition 3 / D22): the clinic comes from the token
through Thulasi's core, never from client input, and our own screens never call /fhir - they
use /api/v1. Two seams stand in for core code that does not exist yet (issue #12), and both
raise NotImplementedError until it does:

- ``machine_token_auth``: the machine-token check, which gives the clinic and the client.
- ``fhir_db``: the database session for /fhir. It is deliberately not ``tenant_db``: /fhir runs
  as ``shri_fhir_reader`` (``FHIR_DATABASE_URL``, read-only, D22/D23), with the clinic taken
  from the machine token. Thulasi's core will provide it.

Tests exercise everything above the seams through ``app.dependency_overrides``.

Search is POST, not GET-with-query-params (D13/D22): ``family=``, ``identifier=`` and
``birthdate=`` in a URL query string would put PHI in logs and server access records, which
D13 forbids. The query string itself never existed for this endpoint even before - this is a
request *body* - but the old GET version's audit record logged ``request.url.query`` verbatim
(the raw query string with these same PHI-bearing values) into ``audit_event.reason``; this
version logs only which parameter *names* were searched, not their values.
"""
from __future__ import annotations

import datetime as dt
import os
import uuid
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import Select, func, insert, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.constraints import patient_column
from app.db.errors import db_error_detail
from app.db.models import FHIR_RESOURCES, MAPPERS
from app.db.models.admin.platform import AuditEvent
from app.db.models.fhir.records import FhirResourceHistory
from app.fhir.serializer import SnapshotRow, to_fhir

router = APIRouter(prefix="/fhir/r4", tags=["FHIR R4"])
FHIR_JSON = "application/fhir+json"
Patient = FHIR_RESOURCES["Patient"]
Identifier = MAPPERS["identifier"]
HumanName = MAPPERS["human_name"]

FHIR_BASE_URL = os.environ.get("SHRI_FHIR_BASE_URL", "https://fhir.company-domain.invalid/r4")
FHIR_MAX_PAGE_SIZE = int(os.environ.get("SHRI_FHIR_MAX_PAGE_SIZE", "200"))


@dataclass(frozen=True)
class AuthContext:
    """Same shape Sam's proposal used, kept so tests can override this dependency the same way.
    Populated by Thulasi's machine-token check (see module docstring), never decoded here."""
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    roles: frozenset[str] = field(default_factory=frozenset)
    correlation_id: str | None = None


async def machine_token_auth() -> AuthContext:
    """Seam for Thulasi's machine-token check (backend/app/core/, not yet on `main`).

    Outside callers of /fhir authenticate with a machine token whose claims give the tenant;
    that check - and the HTTP 401 it raises on a missing/invalid token - belongs in
    backend/app/core/, not here (D3: security lives in the middleware). Wire the real
    dependency in once that module exists; until then this seam makes the gap explicit instead
    of silently accepting unauthenticated requests.
    """
    raise NotImplementedError(
        "machine_token_auth is a seam for Thulasi's machine-token check (backend/app/core/), "
        "which does not exist on main yet - see the schema-adoption report. Override this "
        "dependency in tests; wire the real check in here once backend/app/core/ lands.")


def fhir_response(body: dict[str, Any], status: int = 200,
                  headers: dict[str, str] | None = None) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=FHIR_JSON, headers=headers)


def outcome(status: int, code: str, text: str) -> HTTPException:
    return HTTPException(status, {"resourceType": "OperationOutcome", "issue": [
        {"severity": "error", "code": code, "diagnostics": text}]})


def outcome_from_db_error(exc: DBAPIError) -> HTTPException:
    """Maps a caught DBAPIError (constraint/trigger/RLS violation) to an OperationOutcome,
    using app.db.errors's format-agnostic status/detail mapping."""
    detail = db_error_detail(exc)
    code = ("conflict" if detail.status == 409 else "forbidden" if detail.status == 403 else
            "invariant" if detail.status == 422 else "exception")
    return outcome(detail.status, code, detail.message or "database error")


def resource_class(rtype: str) -> type[Any]:
    cls = FHIR_RESOURCES.get(rtype)
    if cls is None:
        raise outcome(404, "not-supported", f"resource type {rtype} is not supported")
    return cls


def patient_id_of(cls: type[Any], obj: Any) -> uuid.UUID | None:
    if cls is Patient:
        pid: uuid.UUID | None = obj.id
        return pid
    col = patient_column(cls.__table__)
    pid = getattr(obj, col.key, None) if col is not None else None
    return pid


async def fhir_db(ctx: AuthContext = Depends(machine_token_auth)) -> AsyncIterator[AsyncSession]:
    """Seam for the /fhir database session, which Thulasi's core will provide (D22, D23).

    What the real dependency must do, so this module works unchanged on top of it:
    - connect as ``shri_fhir_reader`` through ``FHIR_DATABASE_URL``, never as ``shri_app``;
    - set ``app.current_tenant_id``, ``app.current_user_id`` and ``app.correlation_id`` from the
      machine token, transaction-local, and again for every new transaction on the session
      (this module commits mid-request: see ``audit``), exactly as ``tenant_db`` does;
    - roll back whatever is not committed when the request ends.

    ``shri_fhir_reader`` may read ``clinical`` and insert into ``audit.audit_event`` (migration
    0003), nothing more: no reading audit rows and no access to ``audit.break_glass_access``.
    """
    raise NotImplementedError(
        "fhir_db is a seam for the /fhir session from Thulasi's core (shri_fhir_reader, clinic "
        "from the machine token). Override this dependency in tests.")
    yield  # pragma: no cover  (makes this an async generator, like the real dependency)


async def audit(db: AsyncSession, ctx: AuthContext, action: str, outcome_: str, *,
                entity_type: str | None = None, entity_id: Any = None, version: int | None = None,
                patient_id: uuid.UUID | None = None, reason: str | None = None,
                category: str = "phi-read") -> None:
    """Writes one audit row and commits it. /fhir changes nothing else, so committing here is
    what makes the audit row outlast the request, including a request that ends in a 404.

    An INSERT with no RETURNING: shri_fhir_reader may insert audit rows but not read them (D23
    as amended). ``.inline()`` is what stops SQLAlchemy from adding ``RETURNING`` to fetch the
    identity id; an ORM ``add()`` would too. The row's id, event_uuid and recorded_at come from
    the database and Python defaults, and nothing here needs them. If the insert or the commit
    fails, the request fails with it (fail closed, T17)."""
    await db.execute(insert(AuditEvent).inline().values(
        tenant_id=ctx.tenant_id, actor_type="user", actor_user_id=ctx.user_id,
        action=action, category=category, outcome=outcome_, entity_type=entity_type,
        entity_id=str(entity_id) if entity_id else None,
        entity_version_id=version, patient_id=patient_id, reason=reason,
        purpose_of_use="TREAT", correlation_id=ctx.correlation_id))
    await db.commit()


async def record_lookup_denied(db: AsyncSession, rtype: str, rid: uuid.UUID) -> None:
    """A resource ID this request asked for is not visible to ``shri_fhir_reader``: either it
    does not exist in this clinic, or its chart is restricted (D22). The database function
    (migration 0006) decides which and writes the audit row itself; it returns nothing, so this
    module never learns which, and neither does the client. Committed like ``audit()``."""
    await db.execute(text("SELECT audit.record_fhir_lookup_denied(:rtype, :rid)"),
                     {"rtype": rtype, "rid": rid})
    await db.commit()


async def not_served(db: AsyncSession, rtype: str, rid: uuid.UUID) -> HTTPException:
    """The one 404 for a resource that is missing or restricted: same status, same body."""
    await record_lookup_denied(db, rtype, rid)
    return outcome(404, "not-found", f"{rtype}/{rid} not found")


# --------------------------------------------------------------------------- capability
@router.get("/metadata", include_in_schema=True)
async def capability_statement() -> JSONResponse:
    resources = [{
        "type": rtype,
        "profile": f"http://hl7.org/fhir/us/core/StructureDefinition/us-core-{rtype.lower()}",
        "interaction": [{"code": "read"}, {"code": "vread"}, {"code": "history-instance"},
                        {"code": "search-type"}],
        "versioning": "versioned",
        "searchParam": [{"name": "patient", "type": "reference"},
                        {"name": "_id", "type": "token"}, {"name": "code", "type": "token"}],
    } for rtype in sorted(FHIR_RESOURCES)]
    return fhir_response({
        "resourceType": "CapabilityStatement", "status": "active", "kind": "instance",
        "date": dt.date.today().isoformat(), "fhirVersion": "4.0.1",
        "format": ["application/fhir+json"],
        "implementation": {"description": "Shri Health FHIR facade", "url": FHIR_BASE_URL},
        "rest": [{"mode": "server", "resource": resources,
                  "security": {"service": [{"coding": [{
                      "system": "http://terminology.hl7.org/CodeSystem/restful-security-service",
                      "code": "SMART-on-FHIR"}]}]}}],
    })


# --------------------------------------------------------------------------- read / vread
@router.get("/{rtype}/{rid}")
async def read(rtype: str, rid: uuid.UUID, db: AsyncSession = Depends(fhir_db),
               ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    obj = await db.get(cls, rid)
    if obj is None:
        raise await not_served(db, rtype, rid)
    pid = patient_id_of(cls, obj)
    version = obj.meta_version_id
    response = fhir_response(to_fhir(obj), headers={
        "ETag": f'W/"{version}"',
        "Last-Modified": obj.meta_last_updated.strftime("%a, %d %b %Y %H:%M:%S GMT")})
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid,
                version=version, patient_id=pid)
    return response


async def _history_rows(db: AsyncSession, rtype: str, rid: uuid.UUID,
                        vid: int | None = None) -> list[FhirResourceHistory]:
    q = select(FhirResourceHistory).where(FhirResourceHistory.resource_type == rtype,
                                          FhirResourceHistory.resource_id == rid)
    if vid is not None:
        q = q.where(FhirResourceHistory.version_id == vid)
    return list((await db.scalars(q.order_by(FhirResourceHistory.version_id.desc()))).all())


@router.get("/{rtype}/{rid}/_history/{vid}")
async def vread(rtype: str, rid: uuid.UUID, vid: int, db: AsyncSession = Depends(fhir_db),
                ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    rows = await _history_rows(db, rtype, rid, vid)
    if not rows:
        # A missing version of a resource the client may see is an ordinary 404. Otherwise
        # the resource itself is missing or restricted (its history is hidden with it).
        if await db.get(cls, rid) is not None:
            raise outcome(404, "not-found", f"{rtype}/{rid}/_history/{vid} not found")
        raise await not_served(db, rtype, rid)
    body = to_fhir(cls, SnapshotRow(rows[0].snapshot))
    pid = rid if cls is Patient else _snapshot_patient(cls, rows[0].snapshot)
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid, version=vid,
                patient_id=pid)
    return fhir_response(body, headers={"ETag": f'W/"{vid}"'})


def _snapshot_patient(cls: type[Any], snap: dict[str, Any]) -> uuid.UUID | None:
    col = patient_column(cls.__table__)
    return uuid.UUID(snap[col.name]) if col is not None and snap.get(col.name) else None


@router.get("/{rtype}/{rid}/_history")
async def history(rtype: str, rid: uuid.UUID, db: AsyncSession = Depends(fhir_db),
                  ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    rows = await _history_rows(db, rtype, rid)
    if not rows:
        raise await not_served(db, rtype, rid)
    pid = rid if cls is Patient else _snapshot_patient(cls, rows[0].snapshot)
    entries = [{"fullUrl": f"{FHIR_BASE_URL}/{rtype}/{rid}/_history/{r.version_id}",
                "resource": to_fhir(cls, SnapshotRow(r.snapshot)),
                "request": {"method": "POST" if r.version_id == 1 else "PUT",
                            "url": f"{rtype}/{rid}"},
                "response": {"status": "201" if r.version_id == 1 else "200",
                             "lastModified": r.recorded_at.isoformat()}} for r in rows]
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid, patient_id=pid)
    return fhir_response({"resourceType": "Bundle", "type": "history", "total": len(entries),
                          "entry": entries})


# --------------------------------------------------------------------------- search (POST, D13)
class SearchParams(BaseModel):
    """Body of ``POST /fhir/r4/{rtype}/_search`` - the same parameters the old GET version took
    as query params, moved into a request body so PHI-bearing values (family, identifier,
    birthdate) never appear in a URL (D13/D22)."""
    patient: str | None = None
    subject: str | None = None
    id: uuid.UUID | None = None
    code: str | None = None
    identifier: str | None = None
    family: str | None = None
    birthdate: dt.date | None = None
    count: int = 50

    # Anything else (_include, _revinclude, _has, chained parameters) is refused with a 400,
    # never silently ignored: a client must not take a partial answer for a full one.
    model_config = ConfigDict(extra="allow")


def _ref_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value.rsplit("/", 1)[-1])
    except ValueError as exc:
        raise outcome(400, "invalid", f"bad reference {value!r}") from exc


@router.post("/{rtype}/_search")
async def search(rtype: str, request: Request, params: SearchParams,
                 db: AsyncSession = Depends(fhir_db),
                 ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    if params.model_extra:
        # Parameter names only, never values (D13).
        raise outcome(400, "not-supported", "unsupported search parameter(s): "
                      + ", ".join(sorted(params.model_extra)))
    q: Select[Any] = select(cls)
    pid: uuid.UUID | None = None
    patient_ref = params.patient or params.subject
    if patient_ref:
        pid = _ref_id(patient_ref)
        col = patient_column(cls.__table__)
        if cls is Patient:
            q = q.where(cls.id == pid)
        elif col is None:
            raise outcome(400, "not-supported", f"{rtype} has no patient search parameter")
        else:
            q = q.where(col == pid)
    if params.id:
        q = q.where(cls.id == params.id)
    if params.code:
        if "code_code" not in cls.__table__.c:
            raise outcome(400, "not-supported", f"{rtype} has no code search parameter")
        system, _, value = params.code.rpartition("|")
        q = q.where(cls.__table__.c.code_code == value)
        if system:
            q = q.where(cls.__table__.c.code_system == system)
    if cls is Patient:
        if params.identifier:
            system, _, value = params.identifier.rpartition("|")
            sub = select(Identifier.patient_id).where(Identifier.value == value)
            if system:
                sub = sub.where(Identifier.system == system)
            q = q.where(cls.id.in_(sub))
        if params.family:
            q = q.where(cls.id.in_(select(HumanName.patient_id).where(
                func.lower(HumanName.family).startswith(params.family.lower()))))
        if params.birthdate:
            q = q.where(cls.birth_date == params.birthdate)
    # Restricted charts never appear: the database hides their rows from shri_fhir_reader, so
    # they are missing from the results and the total alike (D22, migration 0006).
    if pid is not None and await db.get(Patient, pid) is None:
        # The search names a chart this client may not see, or one that does not exist. The
        # database function audits it as a lookup of that chart (restricted or not-found), and
        # the answer is the same empty searchset either way.
        await record_lookup_denied(db, "Patient", pid)
        return fhir_response(_searchset(request, rtype, []))
    count = min(params.count, FHIR_MAX_PAGE_SIZE)
    rows = (await db.scalars(q.order_by(cls.meta_last_updated.desc()).limit(count))).all()
    # Which parameter *names* were searched, never their values (D13: no PHI in the audit log
    # either, not just the URL - this used to be `f"search {request.url.query}"`, the raw query
    # string, which leaked family/identifier/birthdate values verbatim into audit_event.reason).
    searched = ",".join(k for k, v in params.model_dump(exclude={"count"}).items() if v)
    body = _searchset(request, rtype, rows)
    await audit(db, ctx, "read", "success", entity_type=rtype, patient_id=pid,
                reason=f"search params: {searched or 'none'}")
    return fhir_response(body)


def _searchset(request: Request, rtype: str, rows: Sequence[Any]) -> dict[str, Any]:
    return {
        "resourceType": "Bundle", "type": "searchset", "total": len(rows),
        "link": [{"relation": "self", "url": str(request.url)}],
        "entry": [{"fullUrl": f"{FHIR_BASE_URL}/{rtype}/{r.id}",
                   "resource": to_fhir(r), "search": {"mode": "match"}} for r in rows]}
