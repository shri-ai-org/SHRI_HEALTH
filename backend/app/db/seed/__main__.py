"""python -m app.db.seed {starter|demo|reset} (see the package docstring; reset: reset.py)."""
from __future__ import annotations

import os
import sys

from sqlalchemy import Engine, create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.seed.demo import load_demo
from app.db.seed.reset import NotEmpty, reset
from app.db.seed.starter import load_starter, require_dev_environment

LAYERS = {"starter": load_starter, "demo": load_demo}
COMMANDS = (*LAYERS, "reset")


def bypasses_rls(db: Session) -> bool:
    """A superuser or BYPASSRLS login would skip row-level security without a sound."""
    return bool(db.execute(text("SELECT rolsuper OR rolbypassrls FROM pg_roles "
                                "WHERE rolname = current_user")).scalar_one())


def main(argv: list[str]) -> int:
    if len(argv) != 1 or argv[0] not in COMMANDS:
        print(f"usage: python -m app.db.seed {{{'|'.join(COMMANDS)}}}", file=sys.stderr)
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
    if argv[0] == "reset":
        return _reset(engine)
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


def _reset(engine: Engine) -> int:
    try:
        with Session(engine) as db:
            if bypasses_rls(db):
                print("refusing to reset as a role that bypasses row-level security; use "
                      "shri_migrator", file=sys.stderr)
                return 1
        done = reset(engine)
    except (NotEmpty, RuntimeError) as refused:
        print(refused, file=sys.stderr)
        return 1
    finally:
        engine.dispose()
    print(f"reset: migrated to {done.head}; demo clinic has {done.patients} patients and "
          f"{done.appointments} appointments", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
