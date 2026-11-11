"""backup_db.sh and restore_db.sh: their own rules with stand-in tools, and a real dump and
restore of the test database when a PostgreSQL 18 pg_dump is on the PATH (otherwise skipped)."""
from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import pytest
from sqlalchemy import Engine, create_engine, make_url, text

from app.db.tests.conftest import SKIP_WITHOUT_DATABASE, TEST_DATABASE_URL, sync_url

TOOLS = Path(__file__).resolve().parents[1] / "tools"
BACKUP, RESTORE = TOOLS / "backup_db.sh", TOOLS / "restore_db.sh"
BASH = shutil.which("bash") or "/bin/bash"


def _run(script: Path, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603  (our own scripts, fixed arguments)
        [BASH, str(script), *args], capture_output=True, text=True,
        env={**os.environ, **env}, check=False)


def _stub(tmp: Path, name: str, body: str) -> str:
    path = tmp / name
    path.write_text(f"#!/bin/bash\n{body}\n")
    path.chmod(0o755)
    return str(path)


def test_a_backup_is_checked_kept_private_and_pruned(tmp_path: Path) -> None:
    dump = _stub(tmp_path, "pg_dump", "echo dump-of-$3")
    listing = _stub(tmp_path, "pg_restore", "cat >/dev/null; echo '; header'; echo '1; TABLE'")
    out = tmp_path / "backups"
    for _ in range(3):
        done = _run(BACKUP, "demo", str(out), PG_DUMP=dump, PG_RESTORE=listing, KEEP="2")
        assert done.returncode == 0, done.stderr
    kept = sorted(out.glob("demo-*.dump"))
    assert 1 <= len(kept) <= 2                     # two runs in one second share a name
    assert all(p.stat().st_mode & 0o777 == 0o600 for p in kept)
    assert not list(out.glob("*.partial"))


def test_a_dump_that_lists_nothing_is_not_kept(tmp_path: Path) -> None:
    dump = _stub(tmp_path, "pg_dump", "echo broken")
    empty = _stub(tmp_path, "pg_restore", "cat >/dev/null; echo '; header only'")
    done = _run(BACKUP, "demo", str(tmp_path / "b"), PG_DUMP=dump, PG_RESTORE=empty)
    assert done.returncode != 0
    assert not list((tmp_path / "b").iterdir())


@pytest.mark.parametrize(("target", "confirm", "says"), [
    ("postgres", "postgres", "refusing to replace postgres"),
    ("keycloak", "keycloak", "refusing to replace keycloak"),
    ("scratch", "", "set RESTORE_CONFIRM=scratch"),
    ("scratch", "other", "set RESTORE_CONFIRM=scratch"),
])
def test_a_restore_refuses_without_its_confirmation(tmp_path: Path, target: str, confirm: str,
                                                    says: str) -> None:
    dump = tmp_path / "x.dump"
    dump.write_text("x")
    done = _run(RESTORE, str(dump), target, RESTORE_CONFIRM=confirm)
    assert done.returncode != 0 and says in done.stderr


def _pg18() -> str | None:
    tool = shutil.which("pg_dump")
    if tool is None:
        return None
    version = subprocess.run([tool, "--version"],  # noqa: S603  (pg_dump from the PATH)
                             capture_output=True, text=True, check=False).stdout
    return tool if " 18." in version else None


@SKIP_WITHOUT_DATABASE
@pytest.mark.db
@pytest.mark.skipif(_pg18() is None, reason="no PostgreSQL 18 pg_dump on the PATH")
def test_a_dump_restores_with_the_same_rows(tmp_path: Path, admin_engine: Engine) -> None:
    assert TEST_DATABASE_URL
    url = make_url(sync_url())
    env = {"PGHOST": url.host or "localhost", "PGPORT": str(url.port or 5432),
           "PGUSER": url.username or "postgres", "PGPASSWORD": url.password or ""}
    source, target = url.database or "", f"{url.database}_restore_check"
    done = _run(BACKUP, source, str(tmp_path), **env)
    assert done.returncode == 0, done.stderr
    [dump] = tmp_path.glob("*.dump")
    done = _run(RESTORE, str(dump), target, RESTORE_CONFIRM=target, **env)
    assert done.returncode == 0, done.stderr
    counts = ("SELECT (SELECT count(*) FROM clinical.patient), (SELECT count(*) FROM "
              "audit.audit_event), (SELECT count(*) FROM pg_policies)")
    copy = create_engine(url.set(database=target))
    try:
        with admin_engine.connect() as a, copy.connect() as b:
            assert tuple(a.execute(text(counts)).one()) == tuple(b.execute(text(counts)).one())
    finally:
        copy.dispose()
        with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as c:
            c.execute(text(f'DROP DATABASE IF EXISTS "{target}" WITH (FORCE)'))
