"""``ai_provider=stub``: a stand-in that calls no model, so the whole AI flow (draft a note,
decide its sections, sign; summarize a chart) runs on a laptop without an API key. A note draft
is the same fictional draft, in the real output shape, for whatever sections the template has:
the dictation and the chart context are ignored, and the text says so. A chart summary repeats
each chart line it was given as one statement citing that line. Never available in production
(config.py)."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from typing import Any

from .model_client import ModelReply

MODEL = "stub"
NOTICE = "[Sample AI draft: no model is configured, so this text is the same for every visit.]"
_SECTION = re.compile(r"^- (?P<code>[0-9]{1,7}-[0-9]): (?P<title>.+?)(?: \(required\))?$",
                      re.MULTILINE)
#: A fictional follow-up visit, by LOINC section code (the starter templates' sections).
_TEXT: dict[str, str] = {
    "10154-3": "Follow-up of high blood pressure.",
    "10164-2": "Home readings around 150/95 for two weeks. No chest pain, headache or "
               "dizziness. Takes lisinopril 10 mg daily and has not missed doses.",
    "61150-9": "Follow-up of high blood pressure. Home readings around 150/95 for two weeks. "
               "No chest pain, headache or dizziness. Takes lisinopril 10 mg daily.",
    "61149-1": "Blood pressure 152/94 in the office. Heart sounds regular. Lungs clear.",
    "29545-1": "Blood pressure 152/94 in the office. Heart sounds regular. Lungs clear.",
    "51848-0": "Essential hypertension, above goal on the current dose.",
    "18776-5": "Increase lisinopril to 20 mg daily. Recheck blood pressure in two weeks.",
    "51847-2": "Essential hypertension, above goal on the current dose. Increase lisinopril "
               "to 20 mg daily. Recheck blood pressure in two weeks.",
    "69730-0": "Take lisinopril 20 mg once a day. Keep a log of home blood pressure readings "
               "and bring it to the next visit.",
}
NOT_DISCUSSED = "Not discussed"


def note_draft(system_prompt: str) -> dict[str, Any]:
    """The fixed draft for the sections the prompt lists; a section the sample visit has
    nothing for is "Not discussed", as the real prompt asks."""
    sections = [{"code": m["code"], "text": _TEXT.get(m["code"], NOT_DISCUSSED)}
                for m in _SECTION.finditer(system_prompt)]
    first = next((s for s in sections if s["text"] != NOT_DISCUSSED), None)
    if first is not None:
        first["text"] = f"{NOTICE} {first['text']}"
    return {"sections": sections, "unknowns": []}


_LINE = re.compile(r"^(?P<handle>S[0-9]+): (?P<kind>[A-Za-z ]+): (?P<text>.+)$", re.MULTILINE)
_TOPIC = {"Visit": "encounters", "Diagnosis": "diagnoses", "Medication": "medications",
          "Allergy": "allergies", "Lab result": "results"}


def chart_summary(chart_text: str) -> dict[str, Any]:
    """A summary in the real shape: one statement per chart line, citing that line, and the
    parts the prompt marks as not available listed as missing."""
    sections: dict[str, list[dict[str, Any]]] = {}
    for m in _LINE.finditer(chart_text):
        topic = _TOPIC.get(m["kind"].strip())
        if topic is not None:
            sections.setdefault(topic, []).append(
                {"text": f"{m['kind'].strip()}: {m['text'].strip()}", "sources": [m["handle"]]})
    missing = ([] if "results" in sections else
               [{"topic": "results", "description": f"{NOTICE} No lab results were available."}])
    return {"sections": [{"topic": t, "statements": s} for t, s in sections.items()],
            "missing": missing}


class StubModel:
    model = MODEL

    async def complete(self, messages: Sequence[Mapping[str, str]], *, max_tokens: int,
                       schema: Mapping[str, Any] | None = None) -> ModelReply:
        system = "\n".join(m["content"] for m in messages if m["role"] == "system")
        if schema is not None and "insufficientEvidence" in schema.get("required", ()):
            user = "\n".join(m["content"] for m in messages if m["role"] == "user")
            first = _LINE.search(user)                                      # chart Q&A
            return ModelReply(content=json.dumps({
                "statements": [{"text": f"{NOTICE} {first['kind'].strip()}: "
                                        f"{first['text'].strip()}", "sources": [first["handle"]]}]
                if first else [], "insufficientEvidence": True}), model=MODEL, latency_ms=0)
        if schema is not None and "missing" in schema.get("required", ()):    # AI-02
            user = "\n".join(m["content"] for m in messages if m["role"] == "user")
            return ModelReply(content=json.dumps(chart_summary(user)), model=MODEL,
                              latency_ms=0)
        return ModelReply(content=json.dumps(note_draft(system)), model=MODEL, latency_ms=0)
