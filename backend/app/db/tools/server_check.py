"""The database checks of server day (``~/shri-notes/server-day-runbook.md`` step 3), one line
each, pass or fail, after ``deploy.sh up`` or ``reset``.

    SERVER_CHECK_DATABASE_URL=postgresql+psycopg://postgres:…@host:5432/shri \\
        python -m app.db.tools.server_check --patients 505

It connects as the master user, read-only: the patient count needs a role that row security
doesn't hide rows from, and nothing here writes. The URL comes from the environment and is
never printed. Exit status 0 when every check passes, 1 otherwise.
"""
from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import Connection, create_engine, text

HEAD = "0021"
PGVECTOR = "0.8.2"   # RDS's version (D31); the server image pins it


@dataclass(frozen=True)
class Check:
    name: str
    sql: str
    expected: str


# Clinic tables (those with a tenant_id) without row security both enabled and forced: one with it
# switched off entirely counts too (Thulasi on #270).
UNFORCED = ("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
            "WHERE n.nspname IN ('clinical', 'admin', 'audit') AND c.relkind IN ('r', 'p') "
            "AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid "
            "AND a.attname = 'tenant_id' AND NOT a.attisdropped) "
            "AND NOT (c.relrowsecurity AND c.relforcerowsecurity)")


def checks(patients: int, head: str = HEAD, pgvector: str = PGVECTOR) -> list[Check]:
    return [
        Check("migrations at head", "SELECT version_num FROM admin.alembic_version", head),
        Check("pgvector is RDS's (D31)",
              "SELECT extversion FROM pg_extension WHERE extname = 'vector'", pgvector),
        Check("row security on and forced on every clinic table", UNFORCED, "0"),
        Check("collation C.UTF-8 (D33)",
              "SELECT datcollate FROM pg_database WHERE datname = current_database()",
              "C.UTF-8"),
        Check("no service role bypasses row security",
              "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'shri\\_%' "
              "AND (rolbypassrls OR rolsuper)",
              "0"),
        Check("demo patients loaded", "SELECT count(*) FROM clinical.patient", str(patients)),
    ]


def run(conn: Connection, todo: Sequence[Check]) -> list[tuple[Check, str | None]]:
    """Each check with the value the database gave (None: the query itself failed)."""
    results: list[tuple[Check, str | None]] = []
    for check in todo:
        try:
            with conn.begin_nested():
                got = conn.execute(text(check.sql)).scalar()
            results.append((check, None if got is None else str(got)))
        except Exception:   # noqa: BLE001 - a missing table or extension is a failed check
            results.append((check, None))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.db.tools.server_check",
                                     description=__doc__.splitlines()[0])
    parser.add_argument("--patients", type=int, default=505,
                        help="patients the demo seed loads (default 505)")
    parser.add_argument("--head", default=HEAD, help=f"Alembic head (default {HEAD})")
    parser.add_argument("--pgvector", default=PGVECTOR,
                        help=f"pgvector version (default {PGVECTOR})")
    args = parser.parse_args(argv)
    url = os.environ.get("SERVER_CHECK_DATABASE_URL")
    if not url:
        print("server_check: set SERVER_CHECK_DATABASE_URL (the master user)", file=sys.stderr)
        return 2
    engine = create_engine(url)
    try:
        with engine.connect() as conn:
            conn.execute(text("SET TRANSACTION READ ONLY"))
            results = run(conn, checks(args.patients, args.head, args.pgvector))
    finally:
        engine.dispose()
    failed = 0
    for check, got in results:
        ok = got == check.expected
        failed += not ok
        print(f"{'PASS' if ok else 'FAIL'}  {check.name}: {got if got is not None else 'error'}"
              + ("" if ok else f" (expected {check.expected})"))
    print(f"{len(results) - failed} of {len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
