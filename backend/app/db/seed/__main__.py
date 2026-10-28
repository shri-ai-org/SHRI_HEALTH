"""python -m app.db.seed starter: load the starter layer (see the package docstring)."""
from __future__ import annotations

import os
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.seed.starter import load_starter, require_dev_environment

LAYERS = {"starter": load_starter}


def bypasses_rls(db: Session) -> bool:
    """A superuser or BYPASSRLS login would skip row-level security without a sound."""
    return bool(db.execute(text("SELECT rolsuper OR rolbypassrls FROM pg_roles "
                                "WHERE rolname = current_user")).scalar_one())


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in LAYERS:
        print(f"usage: python -m app.db.seed {{{'|'.join(LAYERS)}}}", file=sys.stderr)
        return 2
    try:
        require_dev_environment()        # load_starter checks again: one rule, every caller
    except RuntimeError as refused:
        print(refused, file=sys.stderr)
        return 1
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        print("MIGRATION_DATABASE_URL is not set (the seed runs as shri_migrator)",
              file=sys.stderr)
        return 1
    engine = create_engine(make_url(url).set(drivername="postgresql+psycopg"), poolclass=NullPool)
    try:
        with Session(engine) as db, db.begin():
            if bypasses_rls(db):
                print("refusing to seed as a role that bypasses row-level security; use "
                      "shri_migrator", file=sys.stderr)
                return 1
            LAYERS[argv[0]](db)
    finally:
        engine.dispose()
    print(f"seeded the {argv[0]} layer", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
