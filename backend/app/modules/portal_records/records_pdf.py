"""The "My records" PDF (getPortalRecordDownloadUrl, format ``pdf``; Anand's design §1): a
readable summary of what the portal shows, in the after-visit summary's plain PDF
(``documents.pdf``: standard fonts, no metadata, no new dependency).

Top to bottom: the clinic's name, the title with "Summary, not the complete record" and how to get
the full record under it, the patient's name, date of birth and chart number, and "Generated on
<date> from your patient portal" (no staff user IDs); then, each only when it has
something, allergies and intolerances, active problems, current medications, immunizations,
vital signs (the latest of each kind, then the last 12 months as a table), lab results with
their ranges and H/L flags, imaging reports (text only, no images), visits (date, clinician,
reason) and the after-visit summaries; then the closing line, which says again that this is a
summary. Dates are the clinic's, a visit's its facility's (D40). Allergies, problems and current
medications are never cut; another section cut at its limit says so. Synthetic data only in tests.
"""
from __future__ import annotations

import textwrap
from dataclasses import dataclass, field
from datetime import date, datetime

from ..documents import pdf
from ..documents.after_visit_summary import format_visit_date
from ..history import portal_schemas as hs
from ..medications import portal_schemas as ms
from . import schemas
from .records_repository import Header, ImagingReport, Immunization, Visit

CONTENT_TYPE = pdf.CONTENT_TYPE
#: Said under the title and again at the end (Anand on #480): a summary, never the full record.
LABEL = "Summary, not the complete record"
FULL_COPY = "For a complete copy of your record, contact your clinic."
CLOSING = "This is a summary, not your complete medical record."
_WRAP = 85  # characters per line at 11 pt, as the after-visit summary
VITAL_NAMES = {
    "blood-pressure": "Blood pressure", "heart-rate": "Heart rate",
    "respiratory-rate": "Respiratory rate", "body-temperature": "Temperature",
    "body-height": "Height", "body-weight": "Weight", "bmi": "BMI",
    "oxygen-saturation": "Oxygen saturation", "head-circumference": "Head circumference",
}


@dataclass(frozen=True)
class Section:
    items: list[object]
    truncated: bool = False


@dataclass(frozen=True)
class VisitSummary:
    """An after-visit summary on the list: its visit's start and facility time zone."""
    visit_start: datetime
    time_zone: str


@dataclass(frozen=True)
class Summary:
    header: Header
    generated_at: datetime
    limit: int
    allergies: Section = field(default_factory=lambda: Section([]))
    problems: Section = field(default_factory=lambda: Section([]))
    medications: Section = field(default_factory=lambda: Section([]))
    immunizations: Section = field(default_factory=lambda: Section([]))
    vitals: Section = field(default_factory=lambda: Section([]))  # newest first, 12 months
    lab_results: Section = field(default_factory=lambda: Section([]))
    imaging: Section = field(default_factory=lambda: Section([]))
    visits: Section = field(default_factory=lambda: Section([]))
    visit_summaries: Section = field(default_factory=lambda: Section([]))


def _day(moment: datetime | date | None, zone: str) -> str:
    if moment is None:
        return "Date not recorded"
    if isinstance(moment, datetime):
        return format_visit_date(moment, zone)
    return f"{moment:%B} {moment.day}, {moment.year}"


def _wrapped(value: str, indent: str = "") -> list[pdf.Line]:
    width = _WRAP - len(indent)
    out: list[pdf.Line] = []
    for paragraph in (" ".join(p.split()) for p in value.splitlines()):
        for row in textwrap.wrap(paragraph, width) or [""]:
            out.append(("F1", 11, indent + row))
    return out


def _section(title: str, rows: list[pdf.Line], section: Section, limit: int) -> list[pdf.Line]:
    if not rows:
        return []
    out: list[pdf.Line] = [("F1", 11, ""), ("F2", 12, title), *rows]
    if section.truncated:
        out.append(("F1", 9, f"Only the {limit} most recent are listed. For older items, "
                              "contact your clinic."))
    return out


def _quantity(q: object) -> str:
    value = getattr(q, "value", None)
    unit = getattr(q, "unit", None) or ""
    shown = f"{value:g}" if isinstance(value, float) else str(value)
    return f"{shown} {unit}".strip() if unit not in ("1", "") else shown


def _vital(v: hs.PortalVital) -> str:
    if v.type == "blood-pressure":
        if v.systolic and v.diastolic:
            unit = v.systolic.unit if v.systolic.unit != "1" else ""
            return f"{v.systolic.value:g}/{v.diastolic.value:g} {unit}".strip()
        return "Not recorded"
    return _quantity(v.value) if v.value else "Not recorded"


def _allergy(a: hs.PortalAllergy) -> list[pdf.Line]:
    detail: list[str] = [a.clinical_status]
    if a.criticality:
        detail.append(f"criticality {a.criticality}")
    rows = _wrapped(f"- {a.display} ({', '.join(detail)})")
    for reaction in a.reactions:
        said = ", ".join(reaction.manifestations)
        rows += _wrapped(f"Reaction: {said}" + (f" ({reaction.severity})"
                                                  if reaction.severity else ""), "    ")
    return rows


def _lab(r: schemas.LabResult, zone: str) -> list[pdf.Line]:
    name = r.short_name or (r.code.display if r.code else None) or "Lab result"
    status = f", {r.status}" if r.status and r.status != "final" else ""
    rows = _wrapped(f"- {name} ({_day(r.effective_at or r.issued_at, zone)}{status})")
    for o in r.results or []:
        label = o.short_name or o.code.display or "Result"
        value = _quantity(o.value) if o.value else (o.text or "")
        rng = ""
        if o.reference_range:
            low, high = o.reference_range.low, o.reference_range.high
            rng = (o.reference_range.text or
                   (f"{low:g} to {high:g}" if low is not None and high is not None
                    else f"at least {low:g}" if low is not None
                    else f"at most {high:g}" if high is not None else ""))
        flag = {"H": " H", "L": " L", "A": " abnormal"}.get(o.interpretation or "", "")
        rows += _wrapped(f"{label}: {value}{flag}" + (f" (range {rng})" if rng else ""),
                         "    ")
    if r.conclusion:
        rows += _wrapped(f"Comment: {r.conclusion}", "    ")
    return rows


def _imaging(r: ImagingReport, zone: str) -> list[pdf.Line]:
    status = f", {r.status}" if r.status != "final" else ""
    rows = _wrapped(f"- {r.display} ({_day(r.effective_at or r.issued_at, zone)}{status})")
    for paragraph in r.text:
        rows += _wrapped(paragraph, "    ")
    return rows


def _visit(v: Visit, zone: str) -> list[pdf.Line]:
    line = f"- {_day(v.started_at, v.time_zone or zone)}"
    if v.clinician:
        line += f", {v.clinician}"
    rows = _wrapped(line)
    if v.reasons:
        rows += _wrapped(f"Reason: {'; '.join(v.reasons)}", "    ")
    return rows


def _when(i: Immunization, zone: str) -> str:
    return _day(i.occurred_at, zone) if i.occurred_at else i.occurred_text or "Date not recorded"


def items[T](section: Section, kind: type[T]) -> list[T]:
    return [x for x in section.items if isinstance(x, kind)]


def _vitals(summary: Summary, zone: str) -> list[pdf.Line]:
    readings = items(summary.vitals, hs.PortalVital)
    if not readings:
        return []
    latest: dict[str, hs.PortalVital] = {}
    for v in readings:  # newest first
        latest.setdefault(v.type, v)
    rows: list[pdf.Line] = [("F2", 11, "Latest")]
    for kind, v in latest.items():
        rows += _wrapped(f"- {VITAL_NAMES.get(kind, kind)}: {_vital(v)} "
                         f"({_day(v.effective_at, zone)})")
    rows += [("F1", 11, ""), ("F2", 11, "The last 12 months")]
    for v in readings:
        rows += _wrapped(f"{_day(v.effective_at, zone)}: {VITAL_NAMES.get(v.type, v.type)} "
                         f"{_vital(v)}")
    return rows


def lines(summary: Summary) -> list[pdf.Line]:
    """The summary's lines, top to bottom. A section with nothing in it is left out."""
    h, zone, limit = summary.header, summary.header.time_zone, summary.limit
    out: list[pdf.Line] = [
        ("F2", 18, h.clinic_name),
        ("F1", 14, "Health record summary"),
        ("F2", 11, LABEL),
        ("F1", 11, FULL_COPY),
        ("F1", 11, ""),
        ("F1", 11, f"Patient: {h.patient_name}"),
        ("F1", 11, "Date of birth: "
                   + (_day(h.birth_date, zone) if h.birth_date else "Not recorded")),
    ]
    if h.chart_number:
        out.append(("F1", 11, f"Chart number: {h.chart_number}"))
    out.append(("F1", 11, f"Generated on {_day(summary.generated_at, zone)} from your patient "
                          "portal"))

    out += _section("Allergies and intolerances",
                    [r for a in items(summary.allergies, hs.PortalAllergy) for r in _allergy(a)],
                    summary.allergies, limit)
    out += _section("Active problems and diagnoses",
                    [r for p in items(summary.problems, hs.PortalProblem)
                     for r in _wrapped(f"- {p.display or 'Problem'}"
                                       + (f" (since {p.onset_date})" if p.onset_date else ""))],
                    summary.problems, limit)
    medications: list[pdf.Line] = []
    for m in items(summary.medications, ms.PortalMedication):
        medications += _wrapped(f"- {m.display}")
        if m.dosage_text:
            medications += _wrapped(m.dosage_text, "    ")
        if m.source == "prescription" and m.prescriber_display_name:
            medications += _wrapped(f"Prescribed by {m.prescriber_display_name}", "    ")
        elif m.source == "reported":
            medications += _wrapped("Reported by you", "    ")
    out += _section("Current medications", medications, summary.medications, limit)
    out += _section("Immunizations",
                    [r for i in items(summary.immunizations, Immunization)
                     for r in _wrapped(f"- {i.display} ({_when(i, zone)})")],
                    summary.immunizations, limit)
    out += _section("Vital signs", _vitals(summary, zone), summary.vitals, limit)
    out += _section("Lab results",
                    [r for x in items(summary.lab_results, schemas.LabResult)
                     for r in _lab(x, zone)], summary.lab_results, limit)
    out += _section("Imaging reports",
                    [r for x in items(summary.imaging, ImagingReport) for r in _imaging(x, zone)],
                    summary.imaging, limit)
    out += _section("Visits", [r for v in items(summary.visits, Visit) for r in _visit(v, zone)],
                    summary.visits, limit)
    out += _section("After-visit summaries",
                    [r for d in items(summary.visit_summaries, VisitSummary)
                     for r in _wrapped(f"- Visit of {_day(d.visit_start, d.time_zone)} "
                                       "(download it from Visits)")],
                    summary.visit_summaries, limit)
    out += [("F1", 11, ""), ("F1", 9, CLOSING), ("F1", 9, FULL_COPY)]
    return out


def render(summary: Summary) -> bytes:
    """The summary as PDF bytes. The same summary always gives the same bytes."""
    return pdf.render(lines(summary))
