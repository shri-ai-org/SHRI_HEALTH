"""
English words spoken inside Tamil, put back into English before translation.

IndicConformer writes everything it hears in Tamil script, so a doctor's "BP
konjam high, dose increase pannunga" comes out as பிபி கொஞ்சம் ஹை டோஸ்
இன்க்ரீஸ் பண்ணுங்க. IndicTrans2 translates formal Tamil well but reads those
transliterated English words poorly ("BB", "buy"). Measured on the brief's
sentences, the same words in Latin script translate correctly — so this step
restores them:

  · each Tamil-script word is read aloud into Latin letters (tamil_to_latin);
  · a Tamil case ending on it is set aside (ரிவ்யூக்கு → ரிவ்யூ + க்கு);
  · the reading is compared with how the clinical words below are spelt in Tamil
    script; an exact match (near, for long words) is replaced by the English word,
    the ending kept as -க்கு;
  · a few colloquial forms the translator misreads become their formal ones.
A word is only replaced on a close match to the list, so Tamil words stay Tamil.
"""

from __future__ import annotations

import re
import unicodedata

# How each English word is written when IndicConformer hears it in Tamil speech — the spellings it
# produces, several where Tamil script has more than one. Both sides go through tamil_to_latin, so a
# heard word matches a spelling here only when it sounds the same.
LEXICON: dict[str, list[str]] = {
    # vitals and measures
    'BP': ['பிபி', 'பீபி', 'பீபீ'], 'sugar': ['சுகர்', 'ஷுகர்'], 'pulse': ['பல்ஸ்'], 'temperature': ['டெம்பரேச்சர்', 'டெம்ப்ரேச்சர்', 'டெம்பரேசர்'],
    'oxygen': ['ஆக்ஸிஜன்', 'ஆக்சிஜன்'], 'saturation': ['சாச்சுரேஷன்', 'சாட்டுரேஷன்'], 'weight': ['வெயிட்', 'வெய்ட்'], 'pressure': ['பிரஷர்', 'பிரசர்', 'ப்ரஷர்'],
    'high': ['ஹை'], 'low': ['லோ'], 'normal': ['நார்மல்', 'நார்மல'], 'level': ['லெவல்', 'லெவெல்'], 'control': ['கண்ட்ரோல்', 'கன்ட்ரோல்', 'கன்ரோல்'],
    'fever': ['ஃபீவர்', 'பீவர்'], 'pain': ['பெயின்', 'பெய்ன்'],
    # orders and plans
    'dose': ['டோஸ்'], 'tablet': ['டேப்லெட்', 'டேப்லட்', 'டாப்லெட்'], 'injection': ['இன்ஜெக்ஷன்', 'இஞ்ஜெக்ஷன்', 'இன்ஜக்ஷன்'], 'drip': ['ட்ரிப்', 'டிரிப்'],
    'increase': ['இன்க்ரீஸ்', 'இன்கிரீஸ்', 'இன்கிரிஸ்'], 'decrease': ['டிக்ரீஸ்', 'டிகிரீஸ்'], 'reduce': ['ரெட்யூஸ்', 'ரிட்யூஸ்', 'ரெடியூஸ்'],
    'continue': ['கன்டினியூ', 'கண்டினியூ', 'கன்டின்யூ', 'கண்டின்யூ', 'கான்டினியூ'], 'stop': ['ஸ்டாப்'], 'start': ['ஸ்டார்ட்'], 'change': ['சேஞ்ச்', 'சேன்ஜ்'],
    'review': ['ரிவ்யூ', 'ரிவியூ', 'ரிவ்யு'], 'follow-up': ['ஃபாலோஅப்'], 'follow': ['ஃபாலோ'], 'admit': ['அட்மிட்'], 'discharge': ['டிஸ்சார்ஜ்', 'டிஸ்சார்ச்'],
    'test': ['டெஸ்ட்'], 'report': ['ரிப்போர்ட்', 'ரிப்போட்'], 'scan': ['ஸ்கேன்', 'ஸ்கான்'], 'X-ray': ['எக்ஸ்ரே'], 'ECG': ['ஈசிஜி', 'இசிஜி'], 'CT': ['சிடி'],
    'MRI': ['எம்ஆர்ஐ'], 'ultrasound': ['அல்ட்ராசவுண்ட்', 'அல்ட்ராசவுண்டு'], 'blood': ['ப்ளட்', 'பிளட்'], 'urine': ['யூரின்'], 'culture': ['கல்ச்சர்'],
    'daily': ['டெய்லி'], 'night': ['நைட்'], 'morning': ['மார்னிங்'],
    # medicines doctors say in English
    'metformin': ['மெட்ஃபார்மின்', 'மெட்பார்மின்', 'மெட்ஃபோர்மின்'], 'insulin': ['இன்சுலின்'], 'paracetamol': ['பாராசிட்டமால்', 'பாரசிட்டமால்', 'பாராசெட்டமால்'],
    'amlodipine': ['அம்லோடிபின்', 'அம்லோடிபைன்'], 'atorvastatin': ['அட்டோர்வாஸ்டாடின்', 'அடோர்வாஸ்டாடின்'], 'aspirin': ['ஆஸ்பிரின்', 'ஆஸ்ப்ரின்'],
    'antibiotic': ['ஆன்டிபயாடிக்', 'ஆண்டிபயாட்டிக்'], 'levothyroxine': ['லெவோதைராக்ஸின்'], 'thyroid': ['தைராய்டு', 'தைராய்ட்'],
}

# Tamil case endings that ride on an English stem; the longest is tried first.
SUFFIXES = sorted(['க்கு', 'ுக்கு', 'ல', 'ல்ல', 'ில', 'ில்', 'ஆ', 'ா', 'யா', 'வா', 'ை', 'ஐ', 'ம்', 'லே', 'ோட', 'ஓட', 'ு', 'யை', 'வை', 'ஓட்ட', 'யில', 'ல்'], key=len, reverse=True)

# Spoken forms the translator misreads, and their formal equivalents.
COLLOQUIAL = [
    (re.compile(r'க்கு\s+வாங்க'), 'க்கு வரவும்'),  # "come for …", not "buy"
    (re.compile(r'கழிச்சு'), 'கழித்து'),
]

_CONS = {'க': 'k', 'ங': 'ng', 'ச': 's', 'ஞ': 'nj', 'ட': 't', 'ண': 'n', 'த': 't', 'ந': 'n', 'ப': 'p', 'ம': 'm', 'ய': 'y', 'ர': 'r', 'ல': 'l', 'வ': 'v', 'ழ': 'l', 'ள': 'l', 'ற': 'r', 'ன': 'n', 'ஜ': 'j', 'ஷ': 's', 'ஸ': 's', 'ஹ': 'h'}
_VOWEL = {'அ': 'a', 'ஆ': 'a', 'இ': 'i', 'ஈ': 'i', 'உ': 'u', 'ஊ': 'u', 'எ': 'e', 'ஏ': 'e', 'ஐ': 'ai', 'ஒ': 'o', 'ஓ': 'o', 'ஔ': 'au'}
_SIGN = {'ா': 'a', 'ி': 'i', 'ீ': 'i', 'ு': 'u', 'ூ': 'u', 'ெ': 'e', 'ே': 'e', 'ை': 'ai', 'ொ': 'o', 'ோ': 'o', 'ௌ': 'au'}
_DOUBLED_SIGN = re.compile(r'([\u0BBE-\u0BCD])[\u0BBE-\u0BCD]+')
_TAMIL = re.compile(r'[஀-௿]+')


def tamil_to_latin(word: str) -> str:
    """A Tamil-script word read aloud in plain Latin letters: பிபி → pipi, டோஸ் → tos."""
    out: list[str] = []
    i = 0
    while i < len(word):
        ch = word[i]
        if ch == 'ஃ' and i + 1 < len(word) and word[i + 1] == 'ப':
            out.append('f')
            i += 2
            if i < len(word) and word[i] == '்':
                i += 1
            elif i < len(word) and word[i] in _SIGN:
                out.append(_SIGN[word[i]])
                i += 1
            else:
                out.append('a')
            continue
        if ch in _VOWEL:
            out.append(_VOWEL[ch])
        elif ch in _CONS:
            out.append(_CONS[ch])
            nxt = word[i + 1] if i + 1 < len(word) else ''
            if nxt == '்':
                i += 1
            elif nxt in _SIGN:
                out.append(_SIGN[nxt])
                i += 1
            else:
                out.append('a')
        i += 1
    return ''.join(out)


def _key(word: str) -> str:
    """How a Tamil word sounds, in Latin letters, with doubled consonants merged (டோஸ் and டோஸ்ஸ் alike)."""
    return re.sub(r'(.)\1+', r'\1', tamil_to_latin(word))


def _distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


_KEYS = [(_key(spelling), english) for english, spellings in LEXICON.items() for spelling in spellings]


def _english_for(stem: str) -> tuple[int, str] | None:
    """(sounds off, English word) for the closest clinical word, or None when none is close."""
    k = _key(stem)
    if len(k) < 2:
        return None
    best = None
    for key, english in _KEYS:
        d = _distance(k, key)
        # Up to 7 sounds the match is exact — short Tamil words sound like too many English ones (பல, சுமார்).
        # Longer words may be one sound off, and long drug names two.
        allowed = 0 if len(key) <= 7 else 1 if len(key) <= 10 else 2
        if d <= allowed and (best is None or d < best[0]):
            best = (d, english)
    return best


def restore_english(tamil: str) -> str:
    """பிபி கொஞ்சம் ஹை டோஸ் இன்க்ரீஸ் பண்ணுங்க → BP கொஞ்சம் high dose increase பண்ணுங்க."""
    # The CTC decoder now and then writes a vowel sign or virama twice (இன்்க்ரீஸ், முூழுு); keep one.
    # NFC first, so a split ொ (ெ + ா) is one sign, not two.
    tamil = _DOUBLED_SIGN.sub(r'\1', unicodedata.normalize('NFC', tamil))
    for pat, rep in COLLOQUIAL:
        tamil = pat.sub(rep, tamil)

    def swap(m: re.Match) -> str:
        word = m.group(0)
        # The whole word and each stem + ending compete; the closest wins, and on a tie the ending is kept.
        best = None
        whole = _english_for(word)
        if whole:
            best = (whole[0], 1, whole[1])
        for suf in SUFFIXES:
            if word.endswith(suf) and len(word) > len(suf) + 1:
                hit = _english_for(word[: -len(suf)])
                if hit and (best is None or (hit[0], 0) < best[:2]):
                    best = (hit[0], 0, f'{hit[1]}-{suf}')
        return best[2] if best else word

    return _TAMIL.sub(swap, tamil)
