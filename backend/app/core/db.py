"""Database engine and sessions.

Every transaction on a tenant session sets the clinic (organization) in the PostgreSQL
setting that the row-level security policies read. The setting is transaction-local
(set_config(..., true)), so a pooled connection never carries one clinic's setting into
another request, and it is set again if the session commits and starts a new transaction.
"""

from typing import Any
from uuid import UUID

from sqlalchemy import event, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import Session, SessionTransaction

from app.core.config import Settings

TENANT_KEY = "organization_id"
_SETTING_KEY = "rls_tenant_setting"


class Database:
    def __init__(self, settings: Settings) -> None:
        if settings.database_url is None:
            raise RuntimeError("DATABASE_URL is not configured")
        self.engine: AsyncEngine = create_async_engine(
            settings.database_url.get_secret_value(),
            pool_size=settings.db_pool_size,
            pool_pre_ping=True,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.rls_tenant_setting = settings.rls_tenant_setting

    def tenant_session(self, organization_id: UUID) -> AsyncSession:
        session = self.sessions()
        session.info[TENANT_KEY] = str(organization_id)
        session.info[_SETTING_KEY] = self.rls_tenant_setting
        return session

    async def ping(self) -> None:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def dispose(self) -> None:
        await self.engine.dispose()


@event.listens_for(Session, "after_begin")
def _set_tenant(session: Session, transaction: SessionTransaction, connection: Connection) -> Any:
    organization_id = session.info.get(TENANT_KEY)
    if organization_id is not None:
        connection.execute(
            text("SELECT set_config(:name, :value, true)"),
            {"name": session.info[_SETTING_KEY], "value": organization_id},
        )
