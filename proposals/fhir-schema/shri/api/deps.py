from __future__ import annotations

from collections.abc import AsyncIterator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from shri.core.security import AuthContext, auth_context
from shri.db.session import tenant_session


async def get_db(ctx: AuthContext = Depends(auth_context)) -> AsyncIterator[AsyncSession]:
    async for session in tenant_session(ctx.tenant_id, ctx.user_id, ctx.correlation_id):
        yield session
