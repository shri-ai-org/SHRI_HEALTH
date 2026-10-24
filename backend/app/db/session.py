"""Reference tenant-scoped session for this package's own tests and tooling.

This is NOT the API's ``tenant_db`` dependency - that's Thulasi's (``backend/app/core/db.py``,
D21/ADR-0011 condition 2), which every endpoint actually uses via ``Depends(tenant_db)``. This
module exists so ``backend/app/db/`` can be tested and migrated on its own, and because it is
the reference implementation of the three-setting contract Thulasi's ``tenant_db`` must match:
``app.current_tenant_id``, ``app.current_user_id``, ``app.correlation_id``, set transaction-
local (``set_config(..., true)``) so pooled connections never leak a tenant between requests.
The API connects as ``shri_app`` (NOBYPASSRLS): with no tenant set it sees zero rows.
"""
from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

#: Overridable for tests/CI; production wiring (connection pool size, URL) is Thulasi's
#: core.config, not duplicated here.
DATABASE_URL = os.environ.get(
    "SHRI_DATABASE_URL", "postgresql+psycopg://shri_app@localhost:5432/shri_health")

engine = create_async_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def tenant_session(tenant_id: uuid.UUID, user_id: uuid.UUID | None = None,
                         correlation_id: str | None = None) -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session, session.begin():
        session.sync_session.info["tenant_id"] = tenant_id
        await session.execute(
            text("SELECT set_config('app.current_tenant_id', :t, true), "
                 "set_config('app.current_user_id', :u, true), "
                 "set_config('app.correlation_id', :c, true)"),
            {"t": str(tenant_id), "u": str(user_id or ""), "c": correlation_id or ""})
        yield session


# New rows inherit the session's tenant, so building a resource with child rows (names,
# identifiers, components ...) does not repeat tenant_id on every object. RLS still checks it.
from sqlalchemy import event  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402


@event.listens_for(Session, "before_flush")
def _default_tenant(session: Session, flush_context, instances) -> None:
    tenant = session.info.get("tenant_id")
    if tenant is None:
        return
    for obj in session.new:
        if hasattr(obj, "tenant_id") and getattr(obj, "tenant_id") is None:
            table = getattr(type(obj), "__table__", None)
            if table is not None and not table.c.tenant_id.nullable:
                obj.tenant_id = tenant
