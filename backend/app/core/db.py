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

from collections.abc import Callable
from typing import Any
from uuid import UUID

from pydantic import SecretStr
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
_GUARD_KEY = "shri_tenant_guard"

# session.info key holding the session's clinic as a UUID. Data-access helpers in
# backend/app/db/ read it to fill tenant_id on new rows: only where tenant_id is empty, never
# overwriting one (forced RLS rejects a different clinic anyway). Sessions without a clinic
# don't have the key.
TENANT_ID_INFO_KEY = "tenant_id"

# session.info key holding the Database a tenant session came from, so core can write a row
# that must outlive the request's own transaction (a refused chart access, app/core/access.py).
DATABASE_INFO_KEY = "shri_database"


class Database:
    def __init__(self, settings: Settings, url: SecretStr | None = None) -> None:
        """The API's database (DATABASE_URL, shri_app), or another role's when `url` is given
        (PUBLIC_DATABASE_URL, shri_public)."""
        url = url or settings.database_url
        if url is None:
            raise RuntimeError("DATABASE_URL is not configured")
        self.engine: AsyncEngine = create_async_engine(
            url.get_secret_value(),
            pool_size=settings.db_pool_size,
            pool_pre_ping=True,
        )
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)

    def tenant_session(
        self,
        tenant_id: UUID,
        user_id: UUID,
        correlation_id: str | None = None,
        guard: Callable[[], None] | None = None,
    ) -> AsyncSession:
        """`guard` runs before each transaction's settings are set and may raise to refuse it."""
        session = self.sessions()
        session.info[_GUARD_KEY] = guard
        session.info[TENANT_ID_INFO_KEY] = tenant_id
        session.info[DATABASE_INFO_KEY] = self
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


def session_user_id(session: AsyncSession | Session) -> UUID | None:
    """The signed-in user a tenant session was opened for (tenant_session's user_id)."""
    context = session.info.get(_CONTEXT_KEY)
    return UUID(context[USER_SETTING]) if context else None


@event.listens_for(Session, "after_begin")
def _set_tenant_context(
    session: Session, transaction: SessionTransaction, connection: Connection
) -> Any:
    guard = session.info.get(_GUARD_KEY)
    if guard is not None:
        guard()
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
