"""Canned drafts for the tests: one perfect, one with omissions, one with invented facts."""

from __future__ import annotations

import json
from typing import Any

from shri_eval.dataset import Visit


def perfect(visit: Visit) -> dict[str, Any]:
    return visit.reference_draft()


def with_omissions(visit: Visit) -> dict[str, Any]:
    """The physical exam and patient instructions left empty, and every other section cut to
    its first sentence."""
    sections = []
    for code, text in visit.reference_sections.items():
        if code in ("29545-1", "69730-0"):
            text = ""
        else:
            text = text.split(". ")[0]
        sections.append({"code": code, "text": text})
    return {"sections": sections}


def with_inventions(visit: Visit) -> dict[str, Any]:
    """The reference plus statements the transcript never made: two must-not-invent items and
    an invented follow-up interval."""
    draft = visit.reference_draft()
    made_up = " ".join(f"{item['anyOf'][0]} was discussed and documented."
                       for item in visit.data["mustNotInvent"][:2])
    for s in draft["sections"]:
        if s["code"] == "51847-2":
            s["text"] += f" {made_up} Recheck labs in 11 weeks."
    return draft


MODES = {"perfect": perfect, "omissions": with_omissions, "inventions": with_inventions}


def reply(visit: Visit, mode: str) -> str:
    return json.dumps(MODES[mode](visit))
