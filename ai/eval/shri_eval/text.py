"""Text normalization for the lexical baseline: terms, sentences, content tokens and numbers.

This is deliberately simple (see scoring.py, "Baseline"): lower case, word boundaries, a crude
suffix stemmer, number words to digits and a small table of documentation synonyms. It is a
floor to measure models against, not a clinical-grade fact checker.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

_NUMBER_WORDS = {
    "zero": "0", "one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6",
    "seven": "7", "eight": "8", "nine": "9", "ten": "10", "eleven": "11", "twelve": "12",
    "thirteen": "13", "fourteen": "14", "fifteen": "15", "sixteen": "16", "seventeen": "17",
    "eighteen": "18", "nineteen": "19", "twenty": "20", "thirty": "30", "forty": "40",
    "fifty": "50", "sixty": "60", "once": "1", "twice": "2", "half": "0.5",
}

#: Token-level synonyms: both sides are mapped to the right-hand form before comparing.
SYNONYMS = {
    "milligrams": "mg", "milligram": "mg", "micrograms": "mcg", "microgram": "mcg",
    "kilograms": "kg", "kilogram": "kg", "pounds": "lb", "pound": "lb", "lbs": "lb",
    "percent": "%", "bid": "twice", "daily": "day", "nightly": "night", "nights": "night",
    "nontender": "tender", "edema": "swelling", "dysphagia": "swallowing",
    "photophobia": "light", "ed": "emergency", "er": "emergency", "hours": "hour",
    "weeks": "week", "months": "month", "days": "day", "years": "year",
}

#: Words that carry no clinical fact of their own: English function words and the glue of
#: clinical documentation. Never put a finding, drug, test or diagnosis here.
STOPWORDS = frozenset("""
a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had
has have having he her here hers herself him himself his how i if in into is it its itself just
me more most my no nor not now of off on once only or other our out over own same she should so
some such than that the their them then there these they this those through to too under until
up very was we were what when where which while who whom why will with without would you your
yours per via within upon onto toward since
patient patients pt reports reported reporting states stated notes noted describes described
presents presenting denies denied endorses endorsed today currently current visit return returns
follow follow-up followup plan plans planned continue continued continuing start started
starting stop stopped increase increased decrease decreased discussed counseled advised
instructed recommended recommend review reviewed recheck repeat ordered order orders scheduled
schedule refer referred referral exam examination history assessment subjective objective
symptoms symptom well also takes taking take taken uses using use used given give needed
needs need as-needed prn appropriate likely most consistent findings finding noted including
include includes approximately about around roughly overall since prior previously previous
year-old years-old old male female man woman boy girl
""".split())

_SENTENCE = re.compile(r"(?<=[.!?;])\s+|\n+")
_TOKEN = re.compile(r"[a-z][a-z'\-]*[a-z]|[a-z]")
_NUMBER = re.compile(r"\d+(?:\.\d+)?")


def norm(text: str) -> str:
    """Lower case, typographic quotes and dashes made plain, whitespace collapsed."""
    text = text.lower().replace("’", "'").replace("‘", "'")
    text = text.replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip()


def has_term(text: str, term: str) -> bool:
    """The term appears in the text as whole words (case-insensitive)."""
    pattern = r"(?<![a-z0-9])" + re.escape(norm(term)) + r"(?![a-z0-9])"
    return re.search(pattern, norm(text)) is not None


def any_term(text: str, terms: Iterable[str]) -> list[str]:
    """The terms that appear in the text."""
    return [t for t in terms if has_term(text, t)]


def sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(text) if s and s.strip()]


def stem(token: str) -> str:
    token = token.strip("'-")
    if token.endswith("'s"):
        token = token[:-2]
    token = SYNONYMS.get(token, token)
    for suffix in ("ically", "ation", "ingly", "ness", "ing", "ies", "ied", "ed", "es", "ly",
                   "s"):
        if len(token) - len(suffix) >= 3 and token.endswith(suffix):
            return token[: -len(suffix)]
    return token


def tokens(text: str) -> list[str]:
    """Every word token, hyphenated words also split into their parts."""
    out: list[str] = []
    for tok in _TOKEN.findall(norm(text)):
        out.append(tok)
        if "-" in tok:
            out.extend(p for p in tok.split("-") if p)
    return out


def content_stems(text: str) -> list[str]:
    """Stems of the words that can carry a fact (4+ letters, not a stopword or number word)."""
    out = []
    for tok in _TOKEN.findall(norm(text)):
        if len(tok) < 4 or tok in STOPWORDS or tok in _NUMBER_WORDS:
            continue
        out.append(stem(tok))
    return out


def numbers(text: str) -> set[str]:
    """Numbers in the text, digits and number words alike, canonical ("5.0" is "5")."""
    found = set()
    for n in _NUMBER.findall(norm(text)):
        found.add(n.rstrip("0").rstrip(".") if "." in n else n.lstrip("0") or "0")
    for tok in tokens(text):
        if tok in _NUMBER_WORDS:
            found.add(_NUMBER_WORDS[tok])
    return found


def stem_set(text: str) -> set[str]:
    return {stem(t) for t in tokens(text)}
