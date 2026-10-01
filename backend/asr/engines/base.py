"""
What every speech engine provides, so the pipeline never knows which one it runs.

`transcribe(audio, final, context)` turns 16 kHz mono float32 speech into English.
A partial is a quick look at an utterance still being spoken; a final is the
careful pass once it ends. `context` is the English already settled in this
session, for continuity.
"""

from __future__ import annotations

from typing import Protocol

import numpy as np


class Engine(Protocol):
    name: str

    def transcribe(self, audio: np.ndarray, *, final: bool, context: str = '') -> str: ...

    def describe(self) -> dict: ...
