"""Typed CRUD endpoints for the normalized admin tables, generated from the models.

Request / response schemas are Pydantic models built from the table columns, so the OpenAPI
contract always matches the schema. Tenant isolation is enforced by RLS (the session carries
the tenant); integrity errors come back as 409 with the violated constraint's name.
Platform-wide tables (payer, pharmacy, code systems ...) are read-only here.
"""

import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, create_model
from sqlalchemy import Enum as SAEnum, select
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB
from sqlalchemy.ext.asyncio import AsyncSession

from shri.api.deps import get_db
from shri.core.security import AuthContext, auth_context
from shri.models import GLOBAL_TABLES, MAPPERS
SERVER_COLUMNS = {"id", "tenant_id", "created_at", "updated_at", "created_by_user_id",
                  "updated_by_user_id"}
# Written by dedicated services only (audit trail, AI gateway output, hash chains ...).
NOT_EXPOSED = {"audit_event"}
READ_ONLY = {"ai_request", "ai_suggestion", "integration_message"} | GLOBAL_TABLES


def _py_type(col) -> Any:
    t = col.type
    if isinstance(t, SAEnum):
        return str
    if isinstance(t, ARRAY):
        return list[_item_type(t.item_type)]
    if isinstance(t, JSONB):
        return Any
    if isinstance(t, INET):
        return str
    try:
        return t.python_type
    except NotImplementedError:
        return Any


def _item_type(t) -> Any:
    try:
        return t.python_type
    except NotImplementedError:
        return Any


def _writable(col) -> bool:
    return (col.name not in SERVER_COLUMNS and col.computed is None and col.identity is None
            and not col.name.startswith("meta_"))


def build_schemas(cls: type) -> tuple[type[BaseModel], type[BaseModel], type[BaseModel]]:
    table = cls.__table__
    read_fields, create_fields, patch_fields = {}, {}, {}
    for col in table.columns:
        py = _py_type(col)
        read_fields[col.name] = (Optional[py], None)
        if not _writable(col):
            continue
        optional = col.nullable or col.default is not None or col.server_default is not None
        create_fields[col.name] = (Optional[py], None) if optional else (py, ...)
        patch_fields[col.name] = (Optional[py], None)
    cfg = ConfigDict(from_attributes=True)
    name = cls.__name__
    return (create_model(f"{name}Read", __config__=cfg, **read_fields),
            create_model(f"{name}Create", **create_fields),
            create_model(f"{name}Patch", **patch_fields))


def _row(obj: Any) -> dict:
    return {c.name: getattr(obj, a) for a, c in _columns(type(obj))}


def _columns(cls: type):
    from sqlalchemy import inspect
    return [(attr.key, attr.columns[0]) for attr in inspect(cls).column_attrs]


def _attr_values(cls: type, data: dict) -> dict:
    by_col = {c.name: key for key, c in _columns(cls)}
    return {by_col[k]: v for k, v in data.items() if k in by_col}


def make_router(cls: type) -> APIRouter:
    table = cls.__tablename__
    Read, Create, Patch = build_schemas(cls)
    r = APIRouter(prefix=f"/{table.replace('_', '-')}", tags=[f"admin: {cls.__module__.split('.')[-1]}"])

    @r.get("", response_model=list[Read], name=f"list_{table}")
    async def list_rows(limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0),
                        db: AsyncSession = Depends(get_db)):
        rows = (await db.scalars(select(cls).limit(limit).offset(offset))).all()
        return [_row(o) for o in rows]

    @r.get("/{row_id}", response_model=Read, name=f"get_{table}")
    async def get_row(row_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
        obj = await db.get(cls, row_id)
        if obj is None:
            raise HTTPException(404, f"{table} {row_id} not found")
        return _row(obj)

    if table in READ_ONLY:
        return r

    @r.post("", response_model=Read, status_code=201, name=f"create_{table}")
    async def create_row(body: Create, db: AsyncSession = Depends(get_db),
                         ctx: AuthContext = Depends(auth_context)):
        values = _attr_values(cls, body.model_dump(exclude_unset=True))
        if "tenant_id" in cls.__table__.c:
            values["tenant_id"] = ctx.tenant_id
        if "created_by_user_id" in cls.__table__.c:
            values["created_by_user_id"] = ctx.user_id
        obj = cls(**values)
        db.add(obj)
        await db.flush()
        await db.refresh(obj)
        return _row(obj)

    @r.patch("/{row_id}", response_model=Read, name=f"update_{table}")
    async def update_row(row_id: uuid.UUID, body: Patch, db: AsyncSession = Depends(get_db),
                         ctx: AuthContext = Depends(auth_context)):
        obj = await db.get(cls, row_id)
        if obj is None:
            raise HTTPException(404, f"{table} {row_id} not found")
        for key, value in _attr_values(cls, body.model_dump(exclude_unset=True)).items():
            setattr(obj, key, value)
        if "updated_by_user_id" in cls.__table__.c:
            obj.updated_by_user_id = ctx.user_id
        await db.flush()
        await db.refresh(obj)
        return _row(obj)

    @r.delete("/{row_id}", status_code=204, name=f"delete_{table}")
    async def delete_row(row_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
        obj = await db.get(cls, row_id)
        if obj is None:
            raise HTTPException(404, f"{table} {row_id} not found")
        await db.delete(obj)     # the database refuses tables without DELETE privilege
        await db.flush()
        return Response(status_code=204)

    return r


def admin_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1/admin")
    for name, cls in sorted(MAPPERS.items()):
        if (cls.__module__.rsplit(".", 1)[0] == "shri.models.admin" and name not in NOT_EXPOSED
                and "id" in cls.__table__.c and len(cls.__table__.primary_key.columns) == 1
                and cls.__table__.c.id.primary_key):
            router.include_router(make_router(cls))
    return router

