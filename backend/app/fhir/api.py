"""FHIR R4 facade over the application database (ADR-19, ADR-0011 condition 3): read, vread,
history, POST _search and the CapabilityStatement. Read-only - writes go through the domain
endpoints (sign, order, ...) under /api/v1, not generic FHIR create/update, so the clinical
safety rules stay in one place. Every read is audited; restricted charts (meta.security R / V)
need an active break-the-glass grant.

Access is machine-token only (ADR-0011 condition 3 / D22): the clinic comes from the token
through Thulasi's core, never from client input, and our own screens never call /fhir - they
use /api/v1. ``machine_token_auth`` below is a seam, not an implementation: backend/app/core/
does not exist on `main` yet (see the adoption report), so this raises NotImplementedError
until Thulasi's machine-token check is wired in here. Tests exercise everything above that seam
via ``app.dependency_overrides[machine_token_auth]``.

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
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.constraints import patient_column
from app.db.errors import db_error_detail
from app.db.models import FHIR_RESOURCES, MAPPERS
from app.db.models.admin.platform import AuditEvent, BreakGlassAccess
from app.db.models.fhir.records import FhirResourceHistory
from app.db.session import tenant_session
from app.fhir.serializer import SnapshotRow, to_fhir

router = APIRouter(prefix="/fhir/r4", tags=["FHIR R4"])
FHIR_JSON = "application/fhir+json"
RESTRICTED = {"R", "V"}
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


def fhir_response(body: dict, status: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=FHIR_JSON, headers=headers)


def outcome(status: int, code: str, text: str) -> HTTPException:
    return HTTPException(status, {"resourceType": "OperationOutcome", "issue": [
        {"severity": "error", "code": code, "diagnostics": text}]})


def outcome_from_db_error(exc) -> HTTPException:
    """Maps a caught DBAPIError (constraint/trigger/RLS violation) to an OperationOutcome,
    using app.db.errors's format-agnostic status/detail mapping."""
    detail = db_error_detail(exc)
    code = ("conflict" if detail.status == 409 else "forbidden" if detail.status == 403 else
            "invariant" if detail.status == 422 else "exception")
    return outcome(detail.status, code, detail.message or "database error")


def resource_class(rtype: str) -> type:
    cls = FHIR_RESOURCES.get(rtype)
    if cls is None:
        raise outcome(404, "not-supported", f"resource type {rtype} is not supported")
    return cls


def patient_id_of(cls: type, obj: Any) -> uuid.UUID | None:
    if cls is Patient:
        return obj.id
    col = patient_column(cls.__table__)
    return getattr(obj, col.key, None) if col is not None else None


async def get_db(ctx: AuthContext = Depends(machine_token_auth)):
    async for session in tenant_session(ctx.tenant_id, ctx.user_id, ctx.correlation_id):
        yield session


async def audit(db: AsyncSession, ctx: AuthContext, action: str, outcome_: str, *,
                entity_type: str | None = None, entity_id: Any = None, version: int | None = None,
                patient_id: uuid.UUID | None = None, reason: str | None = None) -> None:
    db.add(AuditEvent(tenant_id=ctx.tenant_id, actor_type="user", actor_user_id=ctx.user_id,
                      action=action, outcome=outcome_, entity_type=entity_type,
                      entity_id=str(entity_id) if entity_id else None,
                      entity_version_id=version, patient_id=patient_id, reason=reason,
                      purpose_of_use="TREAT", correlation_id=ctx.correlation_id))
    await db.flush()


async def ensure_chart_access(db: AsyncSession, ctx: AuthContext,
                              patient_id: uuid.UUID | None) -> None:
    """FR-PAT-01: a restricted chart opens only with an active break-the-glass grant."""
    if patient_id is None:
        return
    security = await db.scalar(select(Patient.meta_security).where(Patient.id == patient_id))
    if not security or not RESTRICTED & set(security):
        return
    granted = await db.scalar(select(func.count()).select_from(BreakGlassAccess).where(
        BreakGlassAccess.patient_id == patient_id, BreakGlassAccess.user_id == ctx.user_id,
        BreakGlassAccess.expires_at > func.now(), BreakGlassAccess.granted_at <= func.now()))
    if not granted:
        # The request transaction rolls back with the 403, so the denial is audited in its own
        # transaction (FRS §6: access denials must be traceable).
        async for own in tenant_session(ctx.tenant_id, ctx.user_id, ctx.correlation_id):
            await audit(own, ctx, "access-denied", "denied", entity_type="Patient",
                        entity_id=patient_id, patient_id=patient_id, reason="restricted chart")
        raise outcome(403, "forbidden", "restricted chart: break-the-glass access required")


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
async def read(rtype: str, rid: uuid.UUID, db: AsyncSession = Depends(get_db),
               ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    obj = await db.get(cls, rid)
    if obj is None:
        raise outcome(404, "not-found", f"{rtype}/{rid} not found")
    pid = patient_id_of(cls, obj)
    await ensure_chart_access(db, ctx, pid)
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid,
                version=obj.meta_version_id, patient_id=pid)
    return fhir_response(to_fhir(obj), headers={
        "ETag": f'W/"{obj.meta_version_id}"',
        "Last-Modified": obj.meta_last_updated.strftime("%a, %d %b %Y %H:%M:%S GMT")})


async def _history_rows(db: AsyncSession, rtype: str, rid: uuid.UUID,
                        vid: int | None = None) -> list[FhirResourceHistory]:
    q = select(FhirResourceHistory).where(FhirResourceHistory.resource_type == rtype,
                                          FhirResourceHistory.resource_id == rid)
    if vid is not None:
        q = q.where(FhirResourceHistory.version_id == vid)
    return list((await db.scalars(q.order_by(FhirResourceHistory.version_id.desc()))).all())


@router.get("/{rtype}/{rid}/_history/{vid}")
async def vread(rtype: str, rid: uuid.UUID, vid: int, db: AsyncSession = Depends(get_db),
                ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    rows = await _history_rows(db, rtype, rid, vid)
    if not rows:
        raise outcome(404, "not-found", f"{rtype}/{rid}/_history/{vid} not found")
    body = to_fhir(cls, SnapshotRow(rows[0].snapshot))
    pid = rid if cls is Patient else _snapshot_patient(cls, rows[0].snapshot)
    await ensure_chart_access(db, ctx, pid)
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid, version=vid,
                patient_id=pid)
    return fhir_response(body, headers={"ETag": f'W/"{vid}"'})


def _snapshot_patient(cls: type, snap: dict) -> uuid.UUID | None:
    col = patient_column(cls.__table__)
    return uuid.UUID(snap[col.name]) if col is not None and snap.get(col.name) else None


@router.get("/{rtype}/{rid}/_history")
async def history(rtype: str, rid: uuid.UUID, db: AsyncSession = Depends(get_db),
                  ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    rows = await _history_rows(db, rtype, rid)
    if not rows:
        raise outcome(404, "not-found", f"{rtype}/{rid} has no history")
    pid = rid if cls is Patient else _snapshot_patient(cls, rows[0].snapshot)
    await ensure_chart_access(db, ctx, pid)
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid, patient_id=pid)
    entries = [{"fullUrl": f"{FHIR_BASE_URL}/{rtype}/{rid}/_history/{r.version_id}",
                "resource": to_fhir(cls, SnapshotRow(r.snapshot)),
                "request": {"method": "POST" if r.version_id == 1 else "PUT",
                            "url": f"{rtype}/{rid}"},
                "response": {"status": "201" if r.version_id == 1 else "200",
                             "lastModified": r.recorded_at.isoformat()}} for r in rows]
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


def _ref_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value.rsplit("/", 1)[-1])
    except ValueError as exc:
        raise outcome(400, "invalid", f"bad reference {value!r}") from exc


@router.post("/{rtype}/_search")
async def search(rtype: str, request: Request, params: SearchParams,
                 db: AsyncSession = Depends(get_db),
                 ctx: AuthContext = Depends(machine_token_auth)) -> JSONResponse:
    cls = resource_class(rtype)
    q = select(cls)
    pid: uuid.UUID | None = None
    if params.patient or params.subject:
        pid = _ref_id(params.patient or params.subject)
        col = patient_column(cls.__table__)
        if cls is Patient:
            q = q.where(cls.id == pid)
        elif col is None:
            raise outcome(400, "not-supported", f"{rtype} has no patient search parameter")
        else:
            q = q.where(col == pid)
        await ensure_chart_access(db, ctx, pid)
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
        # Restricted charts are not listed in searches without a grant.
        if not pid:
            q = q.where(~cls.meta_security.overlap(list(RESTRICTED)))
    count = min(params.count, FHIR_MAX_PAGE_SIZE)
    rows = (await db.scalars(q.order_by(cls.meta_last_updated.desc()).limit(count))).all()
    # Which parameter *names* were searched, never their values (D13: no PHI in the audit log
    # either, not just the URL - this used to be `f"search {request.url.query}"`, the raw query
    # string, which leaked family/identifier/birthdate values verbatim into audit_event.reason).
    searched = ",".join(k for k, v in params.model_dump(exclude={"count"}).items() if v)
    await audit(db, ctx, "read", "success", entity_type=rtype, patient_id=pid,
                reason=f"search params: {searched or 'none'}")
    return fhir_response({
        "resourceType": "Bundle", "type": "searchset", "total": len(rows),
        "link": [{"relation": "self", "url": str(request.url)}],
        "entry": [{"fullUrl": f"{FHIR_BASE_URL}/{rtype}/{r.id}",
                   "resource": to_fhir(r), "search": {"mode": "match"}} for r in rows]})
