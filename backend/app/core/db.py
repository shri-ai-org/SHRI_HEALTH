"""Database engine and sessions.

Every transaction on a tenant session sets the three settings the schema's row-level security
policies and triggers read (DECISIONS D21):

    app.current_tenant_id   the clinic, from the server-side session (never from client input)
    app.current_user_id     the signed-in user
    app.correlation_id      the request ID (X-Request-ID)

They are set with set_config(name, value, true), the parameterised form of SET LOCAL: they last
for the whole transaction, including triggers that fire at COMMIT, and end with it. So a pooled
connection never carries one clinic's settings into another request, and they are set again
when the session commits and starts a new transaction. A session with no clinic sets nothing
and sees zero rows.
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

TENANT_SETTING = "app.current_tenant_id"
USER_SETTING = "app.current_user_id"
CORRELATION_SETTING = "app.correlation_id"

_CONTEXT_KEY = "shri_tenant_context"


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

    def tenant_session(
        self, tenant_id: UUID, user_id: UUID, correlation_id: str | None = None
    ) -> AsyncSession:
        session = self.sessions()
        session.info[_CONTEXT_KEY] = {
            TENANT_SETTING: str(tenant_id),
            USER_SETTING: str(user_id),
            CORRELATION_SETTING: correlation_id or "",
        }
        return session

    async def ping(self) -> None:
        async with self.engine.connect() as conn:
            await conn.execute(text("SELECT 1"))

    async def role_bypasses_rls(self) -> bool:
        """True if the API's own database role is a superuser or has BYPASSRLS (D23 forbids it)."""
        async with self.engine.connect() as conn:
            result = await conn.execute(
                text("SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user")
            )
            return bool(result.scalar_one())

    async def dispose(self) -> None:
        await self.engine.dispose()


@event.listens_for(Session, "after_begin")
def _set_tenant_context(
    session: Session, transaction: SessionTransaction, connection: Connection
) -> Any:
    context = session.info.get(_CONTEXT_KEY)
    if context is not None:
        connection.execute(
            text(
                "SELECT set_config(:t_name, :t, true), set_config(:u_name, :u, true), "
                "set_config(:c_name, :c, true)"
            ),
            {
                "t_name": TENANT_SETTING, "t": context[TENANT_SETTING],
                "u_name": USER_SETTING, "u": context[USER_SETTING],
                "c_name": CORRELATION_SETTING, "c": context[CORRELATION_SETTING],
            },
        )
