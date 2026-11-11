"""What a note draft may know of the chart (chart_context.py): the lines, the sources, and that
a part the user may not read is never read. Synthetic data only."""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast
from uuid import uuid4

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.modules.ai.api import chart_reader
from app.modules.ai.chart_context import (
    ChartContext,
    allergy_lines,
    diagnosis_lines,
    label,
    medication_lines,
)

NOW = datetime(2026, 11, 10, tzinfo=UTC)


def _concept(text: str | None = None, display: str | None = None) -> Any:
    codings = [SimpleNamespace(display=display)] if display else []
    return SimpleNamespace(text=text, codings=codings)


def test_a_concept_is_named_by_its_text_then_its_display() -> None:
    assert label(_concept("Peanuts", "Arachis")) == "Peanuts"
    assert label(_concept(None, "Penicillin G")) == "Penicillin G"
    assert label(_concept()) is None and label(None) is None


def test_only_active_unretracted_records_become_lines() -> None:
    a = SimpleNamespace
    allergies = [a(id=uuid4(), code=_concept("Peanuts"), clinical_status="active",
                   verification_status="confirmed", criticality="high"),
                 a(id=uuid4(), code=_concept("Latex"), clinical_status="resolved",
                   verification_status="confirmed", criticality=None),
                 a(id=uuid4(), code=_concept("Codeine"), clinical_status="active",
                   verification_status="entered-in-error", criticality=None)]
    lines, sources = allergy_lines(allergies)
    assert lines == ["Peanuts (high criticality)"]
    assert [(s.resource_type, s.resource_id) for s in sources] == [
        ("AllergyIntolerance", allergies[0].id)]
    meds = [a(id=uuid4(), medication=_concept("Lisinopril 10 MG"), status="active",
              dosage_text="once daily"),
            a(id=uuid4(), medication=_concept("Amoxicillin"), status="stopped",
              dosage_text=None)]
    assert medication_lines(meds)[0] == ["Lisinopril 10 MG, once daily"]
    dx = [a(id=uuid4(), code=a(code="I10", display="Essential hypertension"),
            verification_status="confirmed"),
          a(id=uuid4(), code=a(code="R51.9", display=None), verification_status="confirmed"),
          a(id=uuid4(), code=a(code="J45", display="Asthma"),
            verification_status="entered-in-error")]
    assert diagnosis_lines(dx)[0] == ["Essential hypertension (I10)", "R51.9"]


def test_the_text_lists_only_the_parts_that_have_lines() -> None:
    assert ChartContext().text() is None
    assert ChartContext(allergies=("Peanuts",), diagnoses=("Essential hypertension (I10)",)
                        ).text() == ("Allergies: Peanuts.\nDiagnoses recorded for this visit: "
                                     "Essential hypertension (I10).")


async def test_a_part_the_user_may_not_read_is_never_read() -> None:
    """No allergies:read, medications:read or encounters:read: nothing is read at all (the
    database session is never touched) and the context is empty."""
    calls: list[Any] = []

    async def check(db: AsyncSession, user: CurrentUser, patient_id: Any) -> None:
        calls.append(patient_id)

    nobody = CurrentUser(id=uuid4(), organization_id=uuid4(), roles=frozenset())
    read = chart_reader(check)
    context = await read(cast(AsyncSession, object()), nobody, uuid4(), uuid4())
    assert context == ChartContext() and calls == []
