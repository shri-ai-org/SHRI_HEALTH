"""Async engine and the tenant-scoped session used by every request.

One transaction per request. ``SET LOCAL``-style ``set_config(..., true)`` scopes the tenant
and user to that transaction, so pooled connections (PgBouncer transaction mode) never leak a
tenant. The API connects as ``shri_app`` (NOBYPASSRLS): with no tenant set it sees zero rows.
"""
from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from shri.core.config import settings

engine = create_async_engine(settings.database_url, pool_pre_ping=True,
                             pool_size=settings.db_pool_size)
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
