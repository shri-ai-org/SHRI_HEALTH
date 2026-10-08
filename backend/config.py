"""
Settings, from the environment — nothing else configures the service.

  ASR_ENGINE          indic | whisper                     (default indic — IndicConformer + IndicTrans2)
  ASR_MODEL           Whisper's final-pass model          (default medium on CPU, large-v3 on GPU)
  ASR_PARTIAL_MODEL   the live-partial model              (default: the same model)
  ASR_DEVICE          auto | cpu | cuda                   (default auto)
  ASR_THREADS         CPU threads for decoding            (default: all cores)
  ASR_LANGUAGE        the spoken language Whisper assumes (default ta — Tamil, English mixed in)
  ASR_DENOISE         1 to run DeepFilterNet before the final pass (default 1; skipped if unavailable)
  ASR_PARTIALS        1 to send live partials, 0 for finals at each pause only (default 1, except Whisper on CPU)
  ASR_TOKEN           a shared token the socket requires as ?token= (default: none)
  ASR_ORIGINS         comma-separated browser origins allowed to connect (default: any)
  ASR_MAX_SESSIONS    dictations at once; one more is refused, and its browser uses its own recogniser (default 2)
  ASR_HOST, ASR_PORT  where uvicorn listens (default 127.0.0.1:8765)
  TELE_DEV            1 opens the teleconsult transcript store (/tele) to localhost pages without a token, for
                      development; without it, /tele serves only when ASR_ORIGINS and ASR_TOKEN are both set
"""

import os
import sys
from dataclasses import dataclass, field


def _has_cuda() -> bool:
    # A Mac has no CUDA, and loading ctranslate2 just to ask brings its own OpenMP, which crashes the
    # Indic engine's torch on Intel Macs (a segfault while the models load).
    if sys.platform == 'darwin':
        return False
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


@dataclass(frozen=True)
class Settings:
    engine: str = os.getenv('ASR_ENGINE', 'indic')
    device: str = field(default_factory=lambda: (os.getenv('ASR_DEVICE', 'auto') if os.getenv('ASR_DEVICE', 'auto') != 'auto' else ('cuda' if _has_cuda() else 'cpu')))
    threads: int = int(os.getenv('ASR_THREADS', str(os.cpu_count() or 4)))
    language: str = os.getenv('ASR_LANGUAGE', 'ta')
    denoise: bool = os.getenv('ASR_DENOISE', '1') == '1'
    # Whisper encodes a fixed 30 s window per decode, so on CPU a one-second partial costs as much as a
    # whole utterance (about 4 s for medium on 4 cores) and comes back empty mid-sentence. Live partials
    # are on for Whisper only with a GPU; on CPU its English arrives at each pause. The Indic pair's cost
    # grows with the audio (about 0.16× real time on 4 cores), so its partials run live on CPU.
    partials: bool = os.getenv('ASR_PARTIALS', '1' if os.getenv('ASR_ENGINE', 'indic') == 'indic' or _has_cuda() else '0') == '1'
    token: str = os.getenv('ASR_TOKEN', '')
    origins: tuple = tuple(o.strip() for o in os.getenv('ASR_ORIGINS', '').split(',') if o.strip())
    max_sessions: int = int(os.getenv('ASR_MAX_SESSIONS', '2'))
    host: str = os.getenv('ASR_HOST', '127.0.0.1')
    port: int = int(os.getenv('ASR_PORT', '8765'))

    @property
    def model(self) -> str:
        return os.getenv('ASR_MODEL') or ('large-v3' if self.device == 'cuda' else 'medium')

    @property
    def partial_model(self) -> str:
        return os.getenv('ASR_PARTIAL_MODEL') or self.model

    @property
    def compute_type(self) -> str:
        return 'float16' if self.device == 'cuda' else 'int8'


SETTINGS = Settings()

# The audio every engine receives: 16 kHz, mono, float32 in [-1, 1].
SAMPLE_RATE = 16_000
