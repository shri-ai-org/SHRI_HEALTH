"""The demo clinic's time zone is San Jose (America/Los_Angeles; standing rule of 13 Nov 2026):
no file in the repository may name the old Central-time zone, its abbreviations, or a fixed
Central offset. Screens show times in the clinic's zone from the API; the backend uses the
facility's own setting; a test or example that needs a fixed zone uses America/Los_Angeles.

It walks the repository (the backend runner's container has no git), skipping installed
packages, caches and build output. No database, no network.
The patterns are written in pieces so this file never matches itself."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]  # backend/app/modules/scheduling/tests/ -> repository

#: The forbidden text: the zone's IANA name, the city, its two abbreviations and its two offsets.
FORBIDDEN = re.compile(
    "|".join((
        r"America/" + "Chi" + "cago",
        r"\b" + "Chi" + r"cago\b",
        r"\b" + "CS" + r"[T]\b",
        r"\b" + "CD" + r"[T]\b",
        r"[+-]0[" + "56" + r"]:00",
    )))

#: Files allowed to keep a match, as repository-relative paths. Empty on purpose: nothing may.
ALLOWLIST: frozenset[str] = frozenset()

#: Folders never read on the walk (installed packages, caches, build output, test artifacts).
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache", ".ruff_cache",
             ".pytest_cache", "test-results", "playwright-report", ".tmp"}


#: Dot folders that are tracked and read.
KEPT_DOT_DIRS = {".github", ".claude"}


def _walk() -> list[Path]:
    found: list[Path] = []
    for path in ROOT.rglob("*"):
        parts = path.relative_to(ROOT).parts
        if any(p in SKIP_DIRS or (p.startswith(".") and p not in KEPT_DOT_DIRS)
               for p in parts[:-1]):
            continue
        # Frontend build output (dist, dist-portal) is generated, not tracked;
        # contracts/openapi/dist is tracked.
        if parts[0] == "frontend" and any(p == "dist" or p.startswith("dist-") for p in parts):
            continue
        if path.is_file():
            found.append(path)
    return found


def _hits() -> list[str]:
    hits: list[str] = []
    for path in _walk():
        rel = path.relative_to(ROOT).as_posix()
        if rel in ALLOWLIST or not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue  # images, archives and other binary files
        for number, line in enumerate(text.splitlines(), start=1):
            if FORBIDDEN.search(line):
                hits.append(f"{rel}:{number}: {line.strip()[:160]}")
    return hits


def test_the_pattern_finds_each_forbidden_form_and_nothing_else() -> None:
    zone, city = "America/" + "Chi" + "cago", "Chi" + "cago"
    for bad in (zone, f"in {city}", "9:00 " + "CS" + "T", "1:30 " + "CD" + "T",
                "T09:00:00-0" + "6:00", "T09:00:00-0" + "5:00", "+0" + "6:00"):
        assert FORBIDDEN.search(bad), bad
    for fine in ("America/Los_Angeles", "9:00 PST", "1:30 PDT", "T09:00:00-08:00", "+05:30",
                 "sha512-8CDTR6xyz", "CSTOM", "ACSTX"):
        assert not FORBIDDEN.search(fine), fine


def test_no_file_names_central_time() -> None:
    assert ALLOWLIST == frozenset()
    hits = _hits()
    assert not hits, (
        "Central time in the repository (the demo clinic is San Jose, America/Los_Angeles; read "
        "the facility's zone, or use America/Los_Angeles where a fixed zone is needed):\n"
        + "\n".join(hits))
