"""The fictional visit set (``ai/eval/data/visits/*.json``) and the note templates it uses."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .schema import validate

DATA = Path(__file__).resolve().parent.parent / "data"
VISITS = DATA / "visits"
VISIT_SCHEMA = DATA / "visit.schema.json"
DRAFT_SCHEMA = DATA / "note_draft.schema.json"
LEXICON = DATA / "medical_terms.json"

#: The seed note templates (backend/app/db/seed/starter.py NOTE_TEMPLATES): section LOINC code,
#: title, required. A test checks they still match the seed.
_NEW_VISIT = (
    ("10154-3", "Chief complaint", True), ("10164-2", "History of present illness", True),
    ("11348-0", "Past medical history", False), ("10157-6", "Family history", False),
    ("29762-2", "Social history", False), ("10187-3", "Review of systems", False),
    ("29545-1", "Physical exam", True), ("51847-2", "Assessment and plan", True),
    ("69730-0", "Patient instructions", False),
)
TEMPLATES: dict[str, tuple[tuple[str, str, bool], ...]] = {
    "NEW-VISIT": _NEW_VISIT,
    "FOLLOW-UP": (
        ("10154-3", "Chief complaint", True), ("10164-2", "Interval history", True),
        ("29545-1", "Physical exam", True), ("51847-2", "Assessment and plan", True),
        ("69730-0", "Patient instructions", False)),
}


@dataclass(frozen=True)
class Visit:
    data: dict[str, Any]

    @property
    def id(self) -> str:
        return str(self.data["id"])

    @property
    def template(self) -> tuple[tuple[str, str, bool], ...]:
        return TEMPLATES[self.data["template"]]

    @property
    def context(self) -> str:
        """What the chart already says about the patient (age and sex), given to the model."""
        p = self.data["patient"]
        return f"{p['age']}-year-old {p['sex']}"

    @property
    def transcript_text(self) -> str:
        return "\n".join(f"{t['speaker'].capitalize()}: {t['text']}"
                         for t in self.data["transcript"])

    @property
    def source_text(self) -> str:
        """Everything a draft may draw on: the chart context and the transcript."""
        return f"Patient: {self.context}.\n{self.transcript_text}"

    @property
    def reference_sections(self) -> dict[str, str]:
        return {s["code"]: s["text"] for s in self.data["referenceNote"]["sections"]}

    def reference_draft(self) -> dict[str, Any]:
        """The reference note in the model's output shape (note_draft.schema.json)."""
        return {"sections": [{"code": c, "text": t}
                             for c, t in self.reference_sections.items()]}


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def visit_files() -> list[Path]:
    return sorted(VISITS.glob("visit-*.json"))


def load_visits(ids: list[str] | None = None) -> list[Visit]:
    """Every visit (or the ones named), each checked against visit.schema.json."""
    schema = load_json(VISIT_SCHEMA)
    visits = []
    for path in visit_files():
        data = load_json(path)
        errors = validate(data, schema)
        if errors:
            raise ValueError(f"{path.name} does not match the visit schema: {errors[:5]}")
        if ids is None or data["id"] in ids:
            visits.append(Visit(data))
    if ids is not None and {v.id for v in visits} != set(ids):
        missing = sorted(set(ids) - {v.id for v in visits})
        raise ValueError(f"unknown visit id(s): {missing}")
    return visits
