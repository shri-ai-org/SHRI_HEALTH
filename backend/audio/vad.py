"""
Where the doctor is speaking — Silero VAD, streamed in 32 ms windows.

`StreamingVad.feed()` takes any amount of 16 kHz audio and returns the events it
crossed: ('start', sample) when speech begins and ('end', sample) after a pause long
enough to close an utterance. `is_speech()` answers for a whole buffer, as the
pipeline's gate.
"""

from __future__ import annotations

import threading

import numpy as np

from config import SAMPLE_RATE

WINDOW = 512  # Silero's window at 16 kHz

# Silero keeps state between windows, so each stream gets its own instance (about 2 MB),
# and the one-shot gate has its own, used by one caller at a time.
_gate = None
_gate_lock = threading.Lock()


def _new_model():
    from silero_vad import load_silero_vad

    return load_silero_vad(onnx=True)


class StreamingVad:
    def __init__(self, threshold: float = 0.5, min_silence_ms: int = 700, speech_pad_ms: int = 200):
        from silero_vad import VADIterator

        self._it = VADIterator(_new_model(), threshold=threshold, sampling_rate=SAMPLE_RATE, min_silence_duration_ms=min_silence_ms, speech_pad_ms=speech_pad_ms)
        self._carry = np.zeros(0, dtype=np.float32)

    def feed(self, audio: np.ndarray) -> list[tuple[str, int]]:
        import torch

        buf = np.concatenate([self._carry, audio])
        events: list[tuple[str, int]] = []
        n = len(buf) // WINDOW * WINDOW
        for i in range(0, n, WINDOW):
            out = self._it(torch.from_numpy(buf[i : i + WINDOW]), return_seconds=False)
            if out:
                for kind in ('start', 'end'):
                    if kind in out:
                        events.append((kind, int(out[kind])))
        self._carry = buf[n:]
        return events

    def reset(self):
        self._it.reset_states()
        self._carry = np.zeros(0, dtype=np.float32)


def is_speech(audio: np.ndarray, threshold: float = 0.5) -> bool:
    """Whether any 32 ms window in the buffer is speech."""
    import torch

    global _gate
    with _gate_lock:
        if _gate is None:
            _gate = _new_model()
        _gate.reset_states()
        for i in range(0, len(audio) - WINDOW + 1, WINDOW):
            if _gate(torch.from_numpy(audio[i : i + WINDOW]), SAMPLE_RATE).item() >= threshold:
                return True
        return False
