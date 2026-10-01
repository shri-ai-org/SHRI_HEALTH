"""
Settings, from the environment — nothing else configures the service.

  ASR_ENGINE          whisper | indic                     (default whisper)
  ASR_MODEL           the final-pass model                (default medium on CPU, large-v3 on GPU)
  ASR_PARTIAL_MODEL   the live-partial model              (default: the same model)
  ASR_DEVICE          auto | cpu | cuda                   (default auto)
  ASR_THREADS         CPU threads for decoding            (default: all cores)
  ASR_LANGUAGE        the spoken language Whisper assumes (default ta — Tamil, English mixed in)
  ASR_DENOISE         1 to run DeepFilterNet before the final pass (default 1; skipped if unavailable)
  ASR_PARTIALS        1 to send live partials, 0 for finals at each pause only (default 1 on GPU, 0 on CPU)
  ASR_TOKEN           a shared token the socket requires as ?token= (default: none)
  ASR_ORIGINS         comma-separated browser origins allowed to connect (default: any)
  ASR_HOST, ASR_PORT  where uvicorn listens (default 127.0.0.1:8765)
"""

import os
from dataclasses import dataclass, field


def _has_cuda() -> bool:
    try:
        import ctranslate2

        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


@dataclass(frozen=True)
class Settings:
    engine: str = os.getenv('ASR_ENGINE', 'whisper')
    device: str = field(default_factory=lambda: (os.getenv('ASR_DEVICE', 'auto') if os.getenv('ASR_DEVICE', 'auto') != 'auto' else ('cuda' if _has_cuda() else 'cpu')))
    threads: int = int(os.getenv('ASR_THREADS', str(os.cpu_count() or 4)))
    language: str = os.getenv('ASR_LANGUAGE', 'ta')
    denoise: bool = os.getenv('ASR_DENOISE', '1') == '1'
    # Whisper encodes a fixed 30 s window per decode, so on CPU a one-second partial costs as much as a
    # whole utterance (about 4 s for medium on 4 cores) and comes back empty mid-sentence. Live partials
    # are on by default only with a GPU; on CPU the English arrives at each pause.
    partials: bool = os.getenv('ASR_PARTIALS', '1' if _has_cuda() else '0') == '1'
    token: str = os.getenv('ASR_TOKEN', '')
    origins: tuple = tuple(o.strip() for o in os.getenv('ASR_ORIGINS', '').split(',') if o.strip())
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
