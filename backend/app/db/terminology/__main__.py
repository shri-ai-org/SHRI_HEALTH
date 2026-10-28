"""python -m app.db.terminology rxnorm <release>: load a terminology release (see the package
docstring)."""
from __future__ import annotations

import os
import re
import sys
from datetime import date
from pathlib import Path

from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.seed.__main__ import bypasses_rls
from app.db.terminology import rxnorm

#: The date in an NLM release name: RxNorm_full_prescribe_10052026.zip is 2026-10-05.
RELEASE_DATE = re.compile(r"(\d{2})(\d{2})(\d{4})")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] != "rxnorm":
        print("usage: python -m app.db.terminology rxnorm <release .zip or rrf folder>",
              file=sys.stderr)
        return 2
    source = Path(argv[1])
    found = RELEASE_DATE.search(source.resolve().name if source.suffix == ".zip"
                                else source.resolve().parent.name)
    if not source.exists() or found is None:
        print(f"{source}: not an NLM release (RxNorm_full_prescribe_MMDDYYYY)", file=sys.stderr)
        return 2
    month, day, year = (int(x) for x in found.groups())
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        print("MIGRATION_DATABASE_URL is not set (the loader runs as shri_migrator)",
              file=sys.stderr)
        return 1
    release = rxnorm.read_release(source, date(year, month, day))
    engine = create_engine(make_url(url).set(drivername="postgresql+psycopg"), poolclass=NullPool)
    try:
        with Session(engine) as db, db.begin():
            if bypasses_rls(db):
                print("refusing to load as a role that bypasses row-level security; use "
                      "shri_migrator", file=sys.stderr)
                return 1
            counts = rxnorm.load(db, release)
    finally:
        engine.dispose()
    print(f"loaded RxNorm {release.version}: {counts}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
