"""
Background noise off the doctor's voice — DeepFilterNet, before the final pass.

DeepFilterNet works at 48 kHz, so the utterance is resampled up and back. It is
optional by design: if the package is missing or fails to load (its torchaudio pins
break on some Python and torch versions), `denoise()` returns the audio unchanged
and `status()` says why — the service never stops for want of a denoiser.
"""

from __future__ import annotations

import logging

import numpy as np

from config import SAMPLE_RATE, SETTINGS

log = logging.getLogger('asr.denoise')

_state: dict = {'model': None, 'df_state': None, 'error': None, 'tried': False}


def _load():
    if _state['tried']:
        return _state['model'] is not None
    _state['tried'] = True
    if not SETTINGS.denoise:
        _state['error'] = 'disabled (ASR_DENOISE=0)'
        return False
    try:
        from df.enhance import init_df

        _state['model'], _state['df_state'], _ = init_df(log_level='ERROR')
        return True
    except Exception as e:  # pragma: no cover — depends on the host
        _state['error'] = f'unavailable: {e.__class__.__name__}: {e}'.splitlines()[0][:200]
        log.warning('DeepFilterNet %s — continuing without denoise', _state['error'])
        return False


def denoise(audio: np.ndarray) -> np.ndarray:
    if len(audio) == 0 or not _load():
        return audio
    try:
        import torch
        import torchaudio.functional as F
        from df.enhance import enhance

        sr = _state['df_state'].sr()
        x = torch.from_numpy(audio).unsqueeze(0)
        up = F.resample(x, SAMPLE_RATE, sr)
        clean = enhance(_state['model'], _state['df_state'], up)
        return F.resample(clean, sr, SAMPLE_RATE).squeeze(0).numpy().astype(np.float32)
    except Exception as e:  # pragma: no cover
        log.warning('denoise failed (%s) — using the raw audio', e)
        return audio


def status() -> str:
    _load()
    return 'on' if _state['model'] is not None else (_state['error'] or 'off')
