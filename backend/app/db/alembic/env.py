"""Alembic environment. Migrations run as shri_migrator (table owner), never as shri_app."""
from __future__ import annotations

import os
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

import app.db.models  # noqa: F401  (registers tables + generated constraints)
from app.db.base import Base

config = context.config
if config.config_file_name:
    fileConfig(config.config_file_name)

URL = os.environ.get("SHRI_MIGRATION_DATABASE_URL",
                     "postgresql+psycopg://shri_migrator@localhost:5432/shri_health")
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
