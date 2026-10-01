"""
The engine registry — ASR_ENGINE picks one. Whisper is built in; the Indic pair
(IndicConformer for Tamil speech, IndicTrans2 for English) is the slot for later
and loads only when asked for.
"""

from __future__ import annotations

from config import SETTINGS


def load_engine():
    if SETTINGS.engine == 'whisper':
        from asr.whisper_engine import WhisperEngine

        return WhisperEngine()
    if SETTINGS.engine == 'indic':
        from asr.engines.indic import IndicEngine

        return IndicEngine()
    raise SystemExit(f'Unknown ASR_ENGINE {SETTINGS.engine!r} — use whisper or indic')
