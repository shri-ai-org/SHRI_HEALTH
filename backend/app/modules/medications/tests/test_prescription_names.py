"""The Prescriptions tab's names (#438): the medication list reads every prescriber's name in its
one statement, so the number of queries never grows with the number of items."""
from __future__ import annotations

import asyncio
import datetime as dt
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

import pytest

from app.db.models.systems import RXNORM

from .. import repository, service
from ..repository import SqlMedicationRepository


def _row(intent: str, signer: str | None) -> SimpleNamespace:
    return SimpleNamespace(
        id=uuid4(), subject_patient_id=uuid4(), intent=intent, status="active", system=RXNORM,
        code="308191", display="amoxicillin 500 MG Oral Capsule", text=None, dosage_text=None,
        note=None, recorded_at=dt.datetime(2026, 11, 18, tzinfo=dt.UTC), recorded_by=uuid4(),
        signer_name=signer)


class CountingSession:
    """Counts statements; every one answers the same rows."""

    def __init__(self, rows: list[SimpleNamespace]) -> None:
        self.rows, self.statements = rows, 0

    async def execute(self, *_args: Any, **_kwargs: Any) -> Any:
        self.statements += 1
        return SimpleNamespace(all=lambda: self.rows)


@pytest.mark.parametrize("items", [1, 60])
def test_the_list_reads_every_name_in_one_statement(items: int) -> None:
    db = CountingSession([_row("order", "  Avery401   Lindqvist58 ") for _ in range(items)])
    found = asyncio.run(SqlMedicationRepository().medications(
        cast(Any, db), uuid4(), ["active"], limit=100, offset=0))
    assert db.statements == 1 and len(found) == items
    assert {service.to_medication(r).prescriber_display_name for r in found} == {
        "Avery401 Lindqvist58"}


def test_a_reported_medicine_never_carries_a_prescriber_name() -> None:
    db = CountingSession([_row("plan", "Somebody")])  # even if a name came back
    (entry,) = asyncio.run(SqlMedicationRepository().medications(
        cast(Any, db), uuid4(), ["active"], limit=10, offset=0))
    shown = service.to_medication(entry)
    assert (shown.source, shown.prescriber_display_name) == ("reported", None)


def test_both_reads_share_one_signer_expression() -> None:
    assert repository._SIGNER_NAME in str(repository._LIST)  # noqa: SLF001
    assert repository._SIGNER_NAME in str(repository._PRESCRIPTION)  # noqa: SLF001
    assert "admin.pharmacy ph" in str(repository._PRESCRIPTION)  # noqa: SLF001
