"""
faster-whisper, translating Tamil — with English mixed in — straight to English.

`task="translate"` with the spoken language fixed to Tamil: Whisper decodes the
Tamil and the English words inside it, and writes English. CUDA float16 where a
GPU exists, int8 on CPU. A lighter model may serve the live partials while the
final pass uses the full one (ASR_PARTIAL_MODEL).
"""

from __future__ import annotations

import logging
import threading
import time

import numpy as np

from config import SETTINGS

log = logging.getLogger('asr.whisper')

# Steers the decoder toward clinical English and its spelling, without adding words of its own.
CLINICAL_PROMPT = 'Clinical dictation by a doctor, in English: blood pressure, sugar, dose, tablet, mg, twice daily, review.'


class WhisperEngine:
    name = 'whisper'

    def __init__(self):
        from faster_whisper import WhisperModel

        t = time.time()
        kw = dict(device=SETTINGS.device, compute_type=SETTINGS.compute_type, cpu_threads=SETTINGS.threads)
        self.final_model = WhisperModel(SETTINGS.model, **kw)
        self.partial_model = self.final_model if SETTINGS.partial_model == SETTINGS.model else WhisperModel(SETTINGS.partial_model, **kw)
        # One decode at a time: on a 4-core server two decodes in parallel are slower than two in turn.
        self.lock = threading.Lock()
        log.info('whisper %s (partials %s) on %s/%s, %d threads, loaded in %.1fs', SETTINGS.model, SETTINGS.partial_model, SETTINGS.device, SETTINGS.compute_type, SETTINGS.threads, time.time() - t)

    def transcribe(self, audio: np.ndarray, *, final: bool, context: str = '') -> str:
        model = self.final_model if final else self.partial_model
        prompt = f'{CLINICAL_PROMPT} {context[-200:]}'.strip()
        with self.lock:
            segments, _ = model.transcribe(
                audio,
                task='translate',
                language=SETTINGS.language,
                beam_size=5 if final else 1,
                temperature=(0.0, 0.2, 0.4) if final else 0.0,
                vad_filter=True,
                condition_on_previous_text=False,
                initial_prompt=prompt,
                without_timestamps=True,
                no_speech_threshold=0.6,
            )
            return ' '.join(s.text.strip() for s in segments if s.no_speech_prob < 0.8)

    def describe(self) -> dict:
        return {'engine': 'whisper', 'model': SETTINGS.model, 'partial_model': SETTINGS.partial_model, 'device': SETTINGS.device, 'compute_type': SETTINGS.compute_type, 'threads': SETTINGS.threads, 'language': SETTINGS.language}
