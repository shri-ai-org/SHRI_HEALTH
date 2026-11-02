"""scripts/check_env.py lists the keys of example.env that a .env lacks, never a value; and
example.env names every variable docker-compose.yml reads, so copying it is enough to start.
Temporary files stand in for .env: the real one is never read."""

import importlib.util
import re
import secrets
from pathlib import Path
from types import ModuleType

import pytest

REPO = Path(__file__).resolve().parents[4]
COMPOSE = REPO / "infra" / "compose"


def _check_env() -> ModuleType:
    spec = importlib.util.spec_from_file_location("check_env", REPO / "scripts" / "check_env.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _files(tmp_path: Path, env: str, example: str) -> list[str]:
    (tmp_path / ".env").write_text(env, encoding="utf-8")
    (tmp_path / "example.env").write_text(example, encoding="utf-8")
    return [str(tmp_path / ".env"), str(tmp_path / "example.env")]


EXAMPLE = "# comment\nPOSTGRES_DB=\n\nSESSION_SECRET=\nPUBLIC_FORM_SECRET=\n"


def test_missing_keys_are_listed_by_name_and_fail(tmp_path: Path,
                                                  capsys: pytest.CaptureFixture[str]) -> None:
    value = secrets.token_hex(16)  # made at run time: no secret-like literal
    args = _files(tmp_path, f"POSTGRES_DB=shri\nSESSION_SECRET={value}\n", EXAMPLE)
    assert _check_env().main(args) == 1
    out = capsys.readouterr()
    assert "PUBLIC_FORM_SECRET" in out.err and "SESSION_SECRET" not in out.err
    assert value not in out.out + out.err


def test_a_complete_env_passes_and_extra_keys_are_only_a_note(
        tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    args = _files(tmp_path, "POSTGRES_DB=a\nSESSION_SECRET=b\nPUBLIC_FORM_SECRET=c\nOLD_KEY=d\n",
                  EXAMPLE)
    assert _check_env().main(args) == 0
    out = capsys.readouterr().out
    assert "OLD_KEY" in out and "=d" not in out


def test_no_env_file_fails_with_how_to_make_one(tmp_path: Path,
                                                capsys: pytest.CaptureFixture[str]) -> None:
    (tmp_path / "example.env").write_text(EXAMPLE, encoding="utf-8")
    assert _check_env().main([str(tmp_path / ".env"), str(tmp_path / "example.env")]) == 1
    assert "copy" in capsys.readouterr().err


def test_example_env_names_every_variable_compose_reads() -> None:
    compose = (COMPOSE / "docker-compose.yml").read_text(encoding="utf-8")
    # ${VAR}, ${VAR:-default}, ${VAR:?message}; $${VAR} is the container's own, not compose's.
    used = set(re.findall(r"(?<!\$)\$\{([A-Z0-9_]+)", compose))
    assert used, "no ${VAR} found: has docker-compose.yml moved?"
    assert sorted(used - set(_check_env().keys(COMPOSE / "example.env"))) == []
