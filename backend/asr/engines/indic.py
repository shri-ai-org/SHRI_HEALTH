"""
The Indic pair — IndicConformer-600M (AI4Bharat) hears Tamil, IndicTrans2
(indic→en, distilled 200M) writes it in English. Both MIT; both gated on Hugging
Face (accept the terms once, then `hf auth login`).

Kept as the extension slot the brief asks for: the pipeline already speaks the
`Engine` protocol, so selecting it is ASR_ENGINE=indic once the models are
downloadable on the host.
"""

from __future__ import annotations

import numpy as np


class IndicEngine:
    name = 'indic'

    def __init__(self):
        raise SystemExit(
            'ASR_ENGINE=indic needs ai4bharat/indic-conformer-600m-multilingual and '
            'ai4bharat/indictrans2-indic-en-dist-200M, which are gated: accept their terms on '
            'Hugging Face, run `hf auth login`, then wire them here.'
        )

    def transcribe(self, audio: np.ndarray, *, final: bool, context: str = '') -> str:  # pragma: no cover
        raise NotImplementedError

    def describe(self) -> dict:  # pragma: no cover
        return {'engine': 'indic'}
