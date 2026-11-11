"""What a note draft may know of the chart: the patient's active allergies and medications and
the visit's diagnoses, read through each module's own service, as the clinician (D37).

Each part is read only when the clinician holds its read permission (``allergies:read``,
``medications:read``, ``encounters:read``), through the same service, facility check and
restricted-chart check as the clinician's own screen; a part they may not read is left out, and
nothing else of the chart is read. The model gets the drug, allergy and diagnosis names only,
never IDs or other patient data, and every record sent is listed in the request's sources
(``ai_request_input_ref``). Entered-in-error records are never read. Nothing here logs.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser

from .schemas import SourceRef

#: At most this many entries per part: enough for a visit, small enough to keep cost flat.
LIMIT = 50


@dataclass(frozen=True)
class ChartContext:
    """The lines the model sees, and the records they came from."""
    allergies: tuple[str, ...] = ()
    medications: tuple[str, ...] = ()
    diagnoses: tuple[str, ...] = ()
    sources: tuple[SourceRef, ...] = ()

    def text(self) -> str | None:
        parts = [(title, lines) for title, lines in (
            ("Allergies", self.allergies), ("Current medications", self.medications),
            ("Diagnoses recorded for this visit", self.diagnoses)) if lines]
        if not parts:
            return None
        return "\n".join(f"{title}: {'; '.join(lines)}." for title, lines in parts)


class ChartReader(Protocol):
    async def __call__(self, db: AsyncSession, user: CurrentUser, patient_id: UUID,
                       encounter_id: UUID) -> ChartContext: ...


def label(concept: Any) -> str | None:
    """A coded concept's name: its text, else its first coding's display."""
    if concept is None:
        return None
    if getattr(concept, "text", None):
        return str(concept.text)
    for coding in getattr(concept, "codings", None) or []:
        if getattr(coding, "display", None):
            return str(coding.display)
    return None


def allergy_lines(found: Sequence[Any]) -> tuple[list[str], list[SourceRef]]:
    lines, sources = [], []
    for a in found:
        name = label(a.code)
        if a.verification_status == "entered-in-error" or a.clinical_status not in (
                None, "active") or name is None:
            continue
        lines.append(f"{name} ({a.criticality} criticality)" if a.criticality else name)
        sources.append(SourceRef("AllergyIntolerance", a.id))
    return lines, sources


def medication_lines(found: Sequence[Any]) -> tuple[list[str], list[SourceRef]]:
    lines, sources = [], []
    for m in found:
        name = label(m.medication)
        if m.status != "active" or name is None:
            continue
        lines.append(f"{name}, {m.dosage_text}" if m.dosage_text else name)
        sources.append(SourceRef("MedicationRequest", m.id))
    return lines, sources


def diagnosis_lines(found: Sequence[Any]) -> tuple[list[str], list[SourceRef]]:
    lines, sources = [], []
    for d in found:
        if d.verification_status == "entered-in-error":
            continue
        name = d.code.display or d.code.code
        lines.append(f"{name} ({d.code.code})" if d.code.display else name)
        sources.append(SourceRef("Condition", d.id))
    return lines, sources
