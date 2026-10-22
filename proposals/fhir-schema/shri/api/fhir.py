"""FHIR R4 facade over the application database (ADR-19): read, vread, history, search and
the CapabilityStatement. Every read is audited; restricted charts (meta.security R / V) need
an active break-the-glass grant. Writes go through the domain endpoints (sign, order, ...),
not generic FHIR create/update, so the clinical safety rules stay in one place."""
from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from shri.api.deps import get_db
from shri.db.session import tenant_session
from shri.core.config import settings
from shri.core.security import AuthContext, auth_context
from shri.fhir.serializer import SnapshotRow, to_fhir
from shri.models import FHIR_RESOURCES, MAPPERS
from shri.models.admin.platform import AuditEvent, BreakGlassAccess
from shri.models.constraints import patient_column
from shri.models.fhir.records import FhirResourceHistory

router = APIRouter(prefix="/fhir/r4", tags=["FHIR R4"])
FHIR_JSON = "application/fhir+json"
RESTRICTED = {"R", "V"}
Patient = FHIR_RESOURCES["Patient"]
Identifier = MAPPERS["identifier"]
HumanName = MAPPERS["human_name"]


def fhir_response(body: dict, status: int = 200, headers: dict | None = None) -> JSONResponse:
    return JSONResponse(body, status_code=status, media_type=FHIR_JSON, headers=headers)


def outcome(status: int, code: str, text: str) -> HTTPException:
    return HTTPException(status, {"resourceType": "OperationOutcome", "issue": [
        {"severity": "error", "code": code, "diagnostics": text}]})


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
        "implementation": {"description": "Shri Health FHIR facade", "url": settings.fhir_base_url},
        "rest": [{"mode": "server", "resource": resources,
                  "security": {"service": [{"coding": [{
                      "system": "http://terminology.hl7.org/CodeSystem/restful-security-service",
                      "code": "SMART-on-FHIR"}]}]}}],
    })


# --------------------------------------------------------------------------- read / vread
@router.get("/{rtype}/{rid}")
async def read(rtype: str, rid: uuid.UUID, db: AsyncSession = Depends(get_db),
               ctx: AuthContext = Depends(auth_context)) -> JSONResponse:
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
                ctx: AuthContext = Depends(auth_context)) -> JSONResponse:
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
                  ctx: AuthContext = Depends(auth_context)) -> JSONResponse:
    cls = resource_class(rtype)
    rows = await _history_rows(db, rtype, rid)
    if not rows:
        raise outcome(404, "not-found", f"{rtype}/{rid} has no history")
    pid = rid if cls is Patient else _snapshot_patient(cls, rows[0].snapshot)
    await ensure_chart_access(db, ctx, pid)
    await audit(db, ctx, "read", "success", entity_type=rtype, entity_id=rid, patient_id=pid)
    entries = [{"fullUrl": f"{settings.fhir_base_url}/{rtype}/{rid}/_history/{r.version_id}",
                "resource": to_fhir(cls, SnapshotRow(r.snapshot)),
                "request": {"method": "POST" if r.version_id == 1 else "PUT",
                            "url": f"{rtype}/{rid}"},
                "response": {"status": "201" if r.version_id == 1 else "200",
                             "lastModified": r.recorded_at.isoformat()}} for r in rows]
    return fhir_response({"resourceType": "Bundle", "type": "history", "total": len(entries),
                          "entry": entries})


# --------------------------------------------------------------------------- search
def _ref_id(value: str) -> uuid.UUID:
    try:
        return uuid.UUID(value.rsplit("/", 1)[-1])
    except ValueError as exc:
        raise outcome(400, "invalid", f"bad reference {value!r}") from exc


@router.get("/{rtype}")
async def search(rtype: str, request: Request, db: AsyncSession = Depends(get_db),
                 ctx: AuthContext = Depends(auth_context),
                 patient: str | None = None, subject: str | None = None,
                 _id: uuid.UUID | None = Query(None, alias="_id"), code: str | None = None,
                 identifier: str | None = None, family: str | None = None,
                 birthdate: dt.date | None = None,
                 _count: int = Query(50, alias="_count", ge=1)) -> JSONResponse:
    cls = resource_class(rtype)
    q = select(cls)
    pid: uuid.UUID | None = None
    if patient or subject:
        pid = _ref_id(patient or subject)
        col = patient_column(cls.__table__)
        if cls is Patient:
            q = q.where(cls.id == pid)
        elif col is None:
            raise outcome(400, "not-supported", f"{rtype} has no patient search parameter")
        else:
            q = q.where(col == pid)
        await ensure_chart_access(db, ctx, pid)
    if _id:
        q = q.where(cls.id == _id)
    if code:
        if "code_code" not in cls.__table__.c:
            raise outcome(400, "not-supported", f"{rtype} has no code search parameter")
        system, _, value = code.rpartition("|")
        q = q.where(cls.__table__.c.code_code == value)
        if system:
            q = q.where(cls.__table__.c.code_system == system)
    if cls is Patient:
        if identifier:
            system, _, value = identifier.rpartition("|")
            sub = select(Identifier.patient_id).where(Identifier.value == value)
            if system:
                sub = sub.where(Identifier.system == system)
            q = q.where(cls.id.in_(sub))
        if family:
            q = q.where(cls.id.in_(select(HumanName.patient_id).where(
                func.lower(HumanName.family).startswith(family.lower()))))
        if birthdate:
            q = q.where(cls.birth_date == birthdate)
        # Restricted charts are not listed in searches without a grant.
        if not pid:
            q = q.where(~cls.meta_security.overlap(list(RESTRICTED)))
    count = min(_count, settings.fhir_max_page_size)
    rows = (await db.scalars(q.order_by(cls.meta_last_updated.desc()).limit(count))).all()
    await audit(db, ctx, "read", "success", entity_type=rtype, patient_id=pid,
                reason=f"search {request.url.query}"[:500])
    return fhir_response({
        "resourceType": "Bundle", "type": "searchset", "total": len(rows),
        "link": [{"relation": "self", "url": str(request.url)}],
        "entry": [{"fullUrl": f"{settings.fhir_base_url}/{rtype}/{r.id}",
                   "resource": to_fhir(r), "search": {"mode": "match"}} for r in rows]})
