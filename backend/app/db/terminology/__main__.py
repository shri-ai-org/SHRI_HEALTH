"""python -m app.db.terminology {rxnorm|icd10cm} <release>: load a terminology release (see the
package docstring)."""
from __future__ import annotations

import os
import re
import sys
from collections.abc import Callable
from datetime import date
from pathlib import Path

from sqlalchemy import Engine, create_engine
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session
from sqlalchemy.pool import NullPool

from app.db.seed.__main__ import bypasses_rls
from app.db.terminology import icd10cm, rxnorm

#: The date in an NLM release name: RxNorm_full_prescribe_10052026.zip is 2026-10-05.
RELEASE_DATE = re.compile(r"(\d{2})(\d{2})(\d{4})")


USAGE = ("usage: python -m app.db.terminology rxnorm <release .zip or rrf folder>\n"
         "       python -m app.db.terminology icd10cm <icd10cm_order_YYYY.txt>")


def _engine() -> Engine | None:
    url = os.environ.get("MIGRATION_DATABASE_URL")
    if not url:
        print("MIGRATION_DATABASE_URL is not set (the loader runs as shri_migrator)",
              file=sys.stderr)
        return None
    return create_engine(make_url(url).set(drivername="postgresql+psycopg"), poolclass=NullPool)


def _run(engine: Engine, load: Callable[[Session], dict[str, int]]) -> dict[str, int] | None:
    try:
        with Session(engine) as db, db.begin():
            if bypasses_rls(db):
                print("refusing to load as a role that bypasses row-level security; use "
                      "shri_migrator", file=sys.stderr)
                return None
            return load(db)
    finally:
        engine.dispose()


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[0] not in ("rxnorm", "icd10cm"):
        print(USAGE, file=sys.stderr)
        return 2
    source = Path(argv[1])
    if argv[0] == "icd10cm":
        try:
            year = icd10cm.release_year(source)
            codes = list(icd10cm.read_order_file(
                source.read_text(encoding="latin-1").splitlines()))
        except (OSError, ValueError) as refused:
            print(refused, file=sys.stderr)
            return 2
        engine = _engine()
        if engine is None:
            return 1
        # A fiscal year's release takes effect on 1 October of the year before.
        counts = _run(engine, lambda db: icd10cm.load(db, codes, date(year - 1, 10, 1)))
        if counts is None:
            return 1
        print(f"loaded ICD-10-CM FY{year}: {counts}", file=sys.stderr)
        return 0
    found = RELEASE_DATE.search(source.resolve().name if source.suffix == ".zip"
                                else source.resolve().parent.name)
    if not source.exists() or found is None:
        print(f"{source}: not an NLM release (RxNorm_full_prescribe_MMDDYYYY)", file=sys.stderr)
        return 2
    month, day, year = (int(x) for x in found.groups())
    engine = _engine()
    if engine is None:
        return 1
    release = rxnorm.read_release(source, date(year, month, day))
    counts = _run(engine, lambda db: rxnorm.load(db, release))
    if counts is None:
        return 1
    print(f"loaded RxNorm {release.version}: {counts}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
