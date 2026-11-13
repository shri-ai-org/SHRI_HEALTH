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
from datetime import datetime, timedelta
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
        # The medication list has no start date: the day it went on the list is the closest,
        # so a "what changed" question can tell a new medication from an old one.
        recorded = getattr(m, "recorded_at", None)
        since = f", on the list since {recorded.date().isoformat()}" if recorded else ""
        lines.append(f"{name}, {m.dosage_text}{since}" if m.dosage_text else f"{name}{since}")
        sources.append(SourceRef("MedicationRequest", m.id))
    return lines, sources


def problem_lines(found: Sequence[Any]) -> tuple[list[str], list[SourceRef]]:
    """The problem list (#280): each problem with its code, status and onset; entered-in-error
    ones never."""
    lines, sources = [], []
    for p in found:
        if p.verification_status == "entered-in-error":
            continue
        name = label(p.code)
        if name is None:
            continue
        coded = next((c.code for c in p.code.codings or [] if c.code), None)
        parts = [f"{name} ({coded})" if coded and coded not in name else name, p.clinical_status]
        if p.onset_date:
            parts.append(f"onset {p.onset_date}")
        if p.abatement_date:
            parts.append(f"resolved {p.abatement_date}")
        lines.append(", ".join(parts))
        sources.append(SourceRef("Condition", p.id))
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


#: At most this many lab lines go to the model: the latest value of each test, then abnormal
#: values from the last ABNORMAL_DAYS days, newest first.
LAB_LINES = 30
LAB_REPORTS = 50
ABNORMAL_DAYS = 365
_FLAG = {"H": "high", "L": "low", "A": "abnormal", "HH": "critically high",
         "LL": "critically low", "N": "normal"}


def _amount(q: Any) -> str | None:
    if q is None or q.value is None:
        return None
    return f"{q.value:g} {q.unit}" if q.unit else f"{q.value:g}"


def _range(r: Any) -> str | None:
    if r is None:
        return None
    if r.text:
        return str(r.text)
    low, high = _amount(r.low), _amount(r.high)
    if low and high:
        return f"{low} to {high}"
    return f"above {low}" if low else (f"below {high}" if high else None)


def lab_lines(reports: Sequence[Any], now: datetime) -> tuple[list[str], list[SourceRef]]:
    """Lab results for a summary, from the orders reads (final, amended, corrected or appended
    reports; final, amended or corrected values; never preliminary or entered-in-error), newest
    report first: the latest value of each test, plus every abnormal value collected in the last
    ABNORMAL_DAYS days, at most LAB_LINES. Each line cites its Observation (a report without
    values cites the DiagnosticReport). Names, values and dates only; never IDs."""
    latest: list[tuple[str, SourceRef]] = []
    abnormal: list[tuple[str, SourceRef]] = []
    seen: set[str] = set()
    cutoff = now - timedelta(days=ABNORMAL_DAYS)
    for report in reports:
        when = report.collected_at or report.issued_at
        day = when.date().isoformat() if when else "date unknown"
        panel = label(report.code) or "Lab report"
        if not report.observations:
            if report.conclusion and panel not in seen:
                seen.add(panel)
                latest.append((f"{panel}, {day}: {report.conclusion}",
                               SourceRef("DiagnosticReport", report.id)))
            continue
        for o in report.observations:
            name = label(o.code) or panel
            value = _amount(o.value) or o.value_text
            if value is None:
                continue
            flag = _FLAG.get(o.interpretation or "")
            reference = _range(o.reference_range)
            extra = "; ".join(x for x in (flag, f"reference {reference}" if reference else None)
                              if x)
            text = f"{name} {value}{f' ({extra})' if extra else ''}, collected {day}"
            line = (text, SourceRef("Observation", o.id))
            key = ":".join(c.code for c in (o.code.codings or []) if c.code) or name
            if key not in seen:
                seen.add(key)
                latest.append(line)
            elif (o.interpretation not in (None, "N") and when is not None
                  and when >= cutoff):
                abnormal.append(line)
    chosen = (latest + abnormal)[:LAB_LINES]
    return [t for t, _ in chosen], [s for _, s in chosen]
