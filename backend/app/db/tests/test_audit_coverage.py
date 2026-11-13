"""Every served operation Anand owns that changes data has a live test of its audit row
(audit_coverage.OWNED_WRITES). No database: reads the bundled contract and the routers."""

from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml  # type: ignore[import-untyped]

from app.db.tests.audit_coverage import OWNED_WRITES
from app.modules.scheduling.tests.facility_scope import served_operations

BACKEND = Path(__file__).resolve().parents[3]
CONTRACT = BACKEND.parent / "contracts" / "openapi" / "dist" / "shri-health.bundled.yaml"
METHODS = {"post", "put", "patch", "delete"}


def _owned_writes() -> set[str]:
    spec = yaml.safe_load(CONTRACT.read_text())
    return {op["operationId"] for item in spec["paths"].values()
            for method, op in item.items()
            if method in METHODS and op.get("x-owner") == "anand"}


def _served() -> set[str]:
    modules = sorted(p.parent.name for p in (BACKEND / "app" / "modules").glob("*/api.py"))
    return set().union(*(served_operations(m) for m in modules))


def test_every_served_write_anand_owns_has_an_audit_test() -> None:
    owned = _owned_writes()
    assert owned, "no x-owner anand writes in the contract"
    missing = sorted((owned & _served()) - OWNED_WRITES.keys())
    assert not missing, f"served without an audit test: {missing}"
    assert not OWNED_WRITES.keys() - owned, "OWNED_WRITES names an operation Anand doesn't own"


@pytest.mark.parametrize("operation", sorted(OWNED_WRITES))
def test_the_named_audit_test_exists(operation: str) -> None:
    path, name = OWNED_WRITES[operation].split("::")
    source = (BACKEND / path).read_text()
    assert re.search(rf"^def {name}\(", source, re.MULTILINE), OWNED_WRITES[operation]
