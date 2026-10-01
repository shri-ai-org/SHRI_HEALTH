"""
The English a model returns, made fit for a clinical note — deterministically.

  · drops the phrases Whisper is known to invent over silence or noise;
  · collapses a phrase repeated back to back (the decoder's loop);
  · expands a short, curated list of clinical shorthand into words, so the note
    reads "blood pressure", never an abbreviation the record forbids;
  · tidies spaces, capitals and the final full stop.
Nothing is paraphrased and nothing is added: every word kept is a word the model heard.
"""

from __future__ import annotations

import re

# Whisper's well-known inventions over silence, music or noise.
HALLUCINATIONS = [
    r'thank(s| you) for watching[.!]?',
    r'please (like and )?subscribe[^.]*[.!]?',
    r'subtitles? by [^.]*[.!]?',
    r'transcribed by [^.]*[.!]?',
    r'(amara\.org|www\.[a-z0-9.-]+)',
    r'♪+',
    r'\[(music|applause|silence|noise)\]',
]

# Clinical shorthand → words. Only unambiguous ones; units (mg, mL, mmHg) stay as written.
ABBREVIATIONS = {
    'BP': 'blood pressure',
    'HR': 'heart rate',
    'RR': 'respiratory rate',
    'RBS': 'random blood sugar',
    'FBS': 'fasting blood sugar',
    'PPBS': 'post-prandial blood sugar',
    'SOB': 'shortness of breath',
    'OD': 'once daily',
    'BD': 'twice daily',
    'BID': 'twice daily',
    'TDS': 'three times a day',
    'TID': 'three times a day',
    'QID': 'four times a day',
    'HS': 'at bedtime',
    'SOS': 'as needed',
    'PRN': 'as needed',
    'NBM': 'nil by mouth',
    'c/o': 'complains of',
    'h/o': 'history of',
    'k/c/o': 'known case of',
}

_ABBR = re.compile(r'(?<![\w/])(' + '|'.join(re.escape(k) for k in sorted(ABBREVIATIONS, key=len, reverse=True)) + r')(?![\w/])')


def _collapse_repeats(text: str) -> str:
    # "increase the dose increase the dose increase the dose" → once. Phrases of 1–8 words.
    words = text.split()
    out: list[str] = []
    i = 0
    while i < len(words):
        for n in range(8, 0, -1):
            seg = words[i : i + n]
            if len(seg) == n and out[-n:] == seg and n * 2 <= len(out) + n:
                i += n
                break
        else:
            out.append(words[i])
            i += 1
    return ' '.join(out)


def clean_text(text: str | None) -> str:
    if not text:
        return ''
    t = text.strip()
    for pat in HALLUCINATIONS:
        t = re.sub(pat, ' ', t, flags=re.IGNORECASE)
    t = _ABBR.sub(lambda m: ABBREVIATIONS[m.group(1)], t)
    t = re.sub(r'\s+', ' ', t).strip(' -–—')
    t = _collapse_repeats(t)
    t = re.sub(r'\s+([,.;:!?])', r'\1', t)
    t = re.sub(r'([,.;:!?])(?=[A-Za-z])', r'\1 ', t)
    if not t:
        return ''
    t = t[0].upper() + t[1:]
    # A sentence's first word after a full stop starts with a capital.
    t = re.sub(r'([.!?]\s+)([a-z])', lambda m: m.group(1) + m.group(2).upper(), t)
    if t[-1] not in '.!?':
        t += '.'
    return t
