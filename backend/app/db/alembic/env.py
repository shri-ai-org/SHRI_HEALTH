"""Alembic environment. Migrations run as shri_migrator (table owner), never as shri_app.

The connection comes from the core's settings (app/core/config.py): MIGRATION_DATABASE_URL,
the one URL per service role that D23 reserves for shri_migrator. Migrations are synchronous,
so the driver is always psycopg v3 whatever driver name the configured URL carries (agreed
with Thulasi, 2026-10-24).
"""
from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool
from sqlalchemy.engine import make_url

import app.db.models  # noqa: F401  (registers tables + generated constraints)
from app.core.config import get_settings
from app.db.base import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

SYNC_DRIVER = "postgresql+psycopg"


def migration_url() -> str:
    secret = get_settings().migration_database_url
    if secret is None:
        raise RuntimeError("MIGRATION_DATABASE_URL is not configured (the shri_migrator login)")
    url = make_url(secret.get_secret_value())
    return url.set(drivername=SYNC_DRIVER).render_as_string(hide_password=False)


URL = migration_url()
target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # pgvector / tsvector index details and expression indexes are not compared reliably.
    return not (type_ == "index" and name and name.startswith(("ix_knowledge_chunk_",)))


def run_migrations_offline() -> None:
    context.configure(url=URL, target_metadata=target_metadata, literal_binds=True,
                      compare_type=True, include_object=include_object,
                      include_schemas=True, version_table_schema="admin")
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(URL, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata,
                          compare_type=True, include_object=include_object,
                          include_schemas=True, version_table_schema="admin")
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
