"""Per-visit scores for an AI-01 note draft.

Four families of scores, each in 0..1 where 1 is best, plus the raw findings behind them:

- **coverage** (omissions): the share of the reference note's non-empty sections the draft
  fills (``sectionCoverage``), and the share of the visit's key facts it keeps (``factRecall``).
- **invention**: statements in the draft with no support in the transcript.
- **medicalTerms**: errors against the reference: its medical terms the draft misses, lexicon
  terms the draft uses that neither the transcript nor the reference has, and doses that differ
  from the reference's dose for the same drug.
- **format**: the draft is JSON matching note_draft.schema.json, uses only its template's
  section codes, once each, and fills every required section.

Baseline (version ``SCORING_VERSION``)
--------------------------------------
The invention check is lexical, a floor to measure models against:

1. every term of the visit's ``mustNotInvent`` list found in a section is an invention;
2. so is a superseded statement of a ``conflicts`` entry (the version the speaker corrected);
3. a sentence is *unsupported* when it has a number the transcript doesn't have, a lexicon term
   (``medical_terms.json``) the transcript doesn't have, or, with 3 or more content words, fewer
   than 60% of them found (stemmed) in the transcript.

Known limits: negation is ignored ("no MRI ordered" counts as mentioning MRI), paraphrases
with new words count as unsupported, and a wrong fact made only of transcript words passes.
Scores are comparable between models on the same set, not absolute.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from typing import Any

from . import text as tx
from .dataset import DRAFT_SCHEMA, LEXICON, Visit, load_json
from .schema import validate

SCORING_VERSION = "lexical-baseline/1"
SUPPORT_THRESHOLD = 0.6
WEIGHTS = {"sectionCoverage": 0.2, "factRecall": 0.25, "invention": 0.25,
           "medicalTerms": 0.15, "format": 0.15}
_DOSE = r"\s+(\d+(?:\.\d+)?)\s*(?:mg|mcg|micrograms?|milligrams?|percent|%)"
_THINK = re.compile(r"<think>.*?</think>", re.DOTALL)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


@dataclass
class Scores:
    sectionCoverage: float
    factRecall: float
    invention: float
    medicalTerms: float
    format: float
    overall: float = 0.0
    findings: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def parse_draft(content: str) -> tuple[dict[str, Any] | None, list[str]]:
    """The model's reply as a draft object: <think> blocks and code fences removed."""
    cleaned = _FENCE.sub("", _THINK.sub("", content).strip()).strip()
    try:
        draft = json.loads(cleaned)
    except json.JSONDecodeError:
        return None, ["/: not valid JSON"]
    if not isinstance(draft, dict):
        return None, ["/: expected object"]
    return draft, []


def _lexicon() -> tuple[list[str], list[str]]:
    lex = load_json(LEXICON)
    return list(lex["drugs"]), list(lex["terms"])


def _section_texts(draft: dict[str, Any] | None) -> dict[str, str]:
    """Code to text, for well-formed sections only (a malformed one counts as absent)."""
    out: dict[str, str] = {}
    if not draft or not isinstance(draft.get("sections"), list):
        return out
    for s in draft["sections"]:
        if isinstance(s, dict) and isinstance(s.get("code"), str) and isinstance(s.get("text"),
                                                                                  str):
            out[s["code"]] = (out.get(s["code"], "") + " " + s["text"]).strip()
    return out


def format_errors(visit: Visit, draft: dict[str, Any] | None, parse: list[str]) -> list[str]:
    if draft is None:
        return parse
    errors = validate(draft, load_json(DRAFT_SCHEMA))
    allowed = {code for code, _, _ in visit.template}
    seen: set[str] = set()
    for i, s in enumerate(draft.get("sections") or []):
        code = s.get("code") if isinstance(s, dict) else None
        if not isinstance(code, str):
            continue
        if code not in allowed:
            errors.append(f"/sections/{i}/code: not a section of the {visit.data['template']} "
                          "template")
        if code in seen:
            errors.append(f"/sections/{i}/code: duplicate")
        seen.add(code)
    texts = _section_texts(draft)
    for code, title, required in visit.template:
        if required and not texts.get(code, "").strip():
            errors.append(f"required section {code} ({title}) is missing or empty")
    return errors


def _unsupported(sentence: str, source: str, source_stems: set[str], source_numbers: set[str],
                 lexicon: list[str]) -> list[str]:
    """Why a sentence is unsupported by the source (empty: supported)."""
    reasons = []
    extra_numbers = tx.numbers(sentence) - source_numbers
    if extra_numbers:
        reasons.append("number:" + ",".join(sorted(extra_numbers)))
    extra_terms = [t for t in tx.any_term(sentence, lexicon) if not tx.has_term(source, t)]
    if extra_terms:
        reasons.append("term:" + ",".join(extra_terms))
    words = tx.content_stems(sentence)
    if len(words) >= 3:
        found = sum(1 for w in words if w in source_stems)
        if found / len(words) < SUPPORT_THRESHOLD:
            reasons.append(f"support:{found}/{len(words)}")
    return reasons


def _doses(text_: str, drug: str) -> set[str]:
    found = re.findall(r"(?<![a-z0-9])" + re.escape(drug) + _DOSE, tx.norm(text_))
    return {tx.numbers(d).pop() for d in found if tx.numbers(d)}


def score(visit: Visit, content: str) -> Scores:
    """Scores one model reply (the raw message content) for one visit."""
    draft, parse = parse_draft(content)
    texts = _section_texts(draft)
    body = "\n".join(texts.values())
    source = visit.source_text
    reference = "\n".join(visit.reference_sections.values())
    drugs, terms = _lexicon()
    lexicon = drugs + terms

    # Coverage (omissions)
    expected = [c for c, t in visit.reference_sections.items() if t.strip()]
    covered = [c for c in expected if texts.get(c, "").strip()]
    facts = visit.data["keyFacts"]
    missing_facts = [f["id"] for f in facts if not tx.any_term(body, f["anyOf"])]
    section_coverage = len(covered) / len(expected) if expected else 1.0
    fact_recall = 1 - len(missing_facts) / len(facts) if facts else 1.0

    # Invention
    must_not = [{"id": n["id"], "terms": hits} for n in visit.data["mustNotInvent"]
                if (hits := tx.any_term(body, n["anyOf"]))]
    superseded = [{"id": c["id"], "terms": hits} for c in visit.data["conflicts"]
                  if (hits := tx.any_term(body, c["supersededAnyOf"]))]
    conflicts_resolved = [c["id"] for c in visit.data["conflicts"]
                          if tx.any_term(body, c["resolvedAnyOf"]) and not
                          tx.any_term(body, c["supersededAnyOf"])]
    stems, nums = tx.stem_set(source), tx.numbers(source)
    all_sentences = [s for t in texts.values() for s in tx.sentences(t)]
    unsupported = []
    for s in all_sentences:
        why = _unsupported(s, source, stems, nums, lexicon)
        if why:
            unsupported.append({"sentence": s, "reasons": why})
    rate = len(unsupported) / len(all_sentences) if all_sentences else 0.0
    invention = max(0.0, 1 - rate - 0.25 * (len(must_not) + len(superseded)))
    if not all_sentences:
        invention = 0.0     # an empty draft invents nothing but says nothing either

    # Medical terms against the reference
    ref_terms = visit.data["medicalTerms"]
    term_misses = [t for t in ref_terms if not tx.has_term(body, t)]
    wrong_terms = [t for t in tx.any_term(body, lexicon)
                   if not tx.has_term(source, t) and not tx.has_term(reference, t)]
    dose_errors = []
    for drug in drugs:
        given, ref_doses = _doses(body, drug), _doses(reference, drug)
        if given and ref_doses and given - ref_doses:
            dose_errors.append({"drug": drug, "doses": sorted(given - ref_doses)})
    matched = len(ref_terms) - len(term_misses)
    denominator = matched + len(term_misses) + len(wrong_terms) + len(dose_errors)
    medical_terms = matched / denominator if denominator else 1.0

    # Format
    errors = format_errors(visit, draft, parse)
    fmt = 1.0 if not errors else 0.0

    parts = {"sectionCoverage": section_coverage, "factRecall": fact_recall,
             "invention": invention, "medicalTerms": medical_terms, "format": fmt}
    overall = sum(WEIGHTS[k] * v for k, v in parts.items())
    return Scores(**{k: round(v, 4) for k, v in parts.items()}, overall=round(overall, 4),
                  findings={
                      "missingSections": [c for c in expected if c not in covered],
                      "missingFacts": missing_facts,
                      "mustNotInventHits": must_not,
                      "supersededStatements": superseded,
                      "conflictsResolved": conflicts_resolved,
                      "conflictsTotal": len(visit.data["conflicts"]),
                      "sentences": len(all_sentences),
                      "unsupportedSentences": unsupported,
                      "termMisses": term_misses,
                      "wrongTerms": wrong_terms,
                      "doseErrors": dose_errors,
                      "formatErrors": errors,
                  })
