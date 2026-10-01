"""
One dictation session, streamed: audio in, English out — live while the doctor
speaks, refined when they pause.

  feed(pcm)  → 16 kHz Int16 frames arrive (about 250 ms each).
  The VAD marks where speech starts and where a pause (700 ms) closes it.
  While speech runs, about every second of new audio the utterance so far is
  decoded quickly → a PARTIAL (skipped when a decode is still running, so the
  socket never queues stale work).
  When the pause comes — or after 25 s of unbroken speech — the utterance is
  denoised and decoded carefully → a FINAL, which replaces its partials.
  stop() flushes whatever is still open.

`process_audio()` is the brief's one-shot path for a single chunk: denoise, gate on
speech, transcribe, clean.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Awaitable, Callable

import numpy as np

from audio.denoise import denoise
from audio.vad import StreamingVad, is_speech
from asr.clean import clean_text
from config import SAMPLE_RATE, SETTINGS

log = logging.getLogger('asr.pipeline')

PARTIAL_EVERY = 1.0  # seconds of new speech between partials
MAX_UTTERANCE = 25.0  # seconds before an unbroken utterance is closed anyway
PRE_ROLL = 0.3  # seconds kept before the VAD's start, so the first syllable is not clipped

Send = Callable[[dict], Awaitable[None]]


def process_audio(engine, audio_chunk: np.ndarray, *, final: bool = True, context: str = '') -> str | None:
    audio = denoise(audio_chunk) if final else audio_chunk
    if not is_speech(audio):
        return None
    return clean_text(engine.transcribe(audio, final=final, context=context))


@dataclass
class Session:
    engine: object
    send: Send
    buffer: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    vad: StreamingVad = field(default_factory=StreamingVad)
    start: int | None = None  # sample index in `buffer` where the open utterance begins
    last_partial_at: int = 0
    partial_task: asyncio.Task | None = None
    finals: list[str] = field(default_factory=list)
    next_id: int = 1
    dropped: int = 0  # samples trimmed off the front of `buffer`; the VAD counts from the session's start

    @property
    def context(self) -> str:
        return ' '.join(self.finals)

    async def feed(self, pcm: bytes) -> None:
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        base = len(self.buffer)
        self.buffer = np.concatenate([self.buffer, audio])
        for kind, at_session in self.vad.feed(audio):
            at = at_session - self.dropped
            if kind == 'start' and self.start is None:
                self.start = max(0, at - int(PRE_ROLL * SAMPLE_RATE))
                self.last_partial_at = at
            elif kind == 'end' and self.start is not None:
                await self._final(self.start, at)
        if self.start is not None:
            now = base + len(audio)
            if now - self.start > MAX_UTTERANCE * SAMPLE_RATE:
                await self._final(self.start, now)
            elif SETTINGS.partials and now - self.last_partial_at >= PARTIAL_EVERY * SAMPLE_RATE:
                self.last_partial_at = now
                self._partial(self.start, now)
        self._trim()

    def _partial(self, a: int, b: int) -> None:
        if self.partial_task and not self.partial_task.done():
            return  # the last one is still decoding — this one would be stale by the time it lands
        audio = self.buffer[a:b].copy()
        context = self.context

        async def run():
            text = await asyncio.to_thread(lambda: clean_text(self.engine.transcribe(audio, final=False, context=context)))
            if text and self.start is not None:
                await self.send({'type': 'partial', 'text': text, 'is_final': False})

        self.partial_task = asyncio.create_task(run())

    async def _final(self, a: int, b: int) -> None:
        self.start = None
        if self.partial_task and not self.partial_task.done():
            self.partial_task.cancel()
        audio = self.buffer[a:b].copy()
        if len(audio) < 0.25 * SAMPLE_RATE:
            return
        await self.send({'type': 'status', 'state': 'processing'})
        context = self.context
        text = await asyncio.to_thread(lambda: process_audio(self.engine, audio, final=True, context=context))
        if text:
            self.finals.append(text)
            await self.send({'type': 'final', 'id': self.next_id, 'text': text, 'is_final': True})
            self.next_id += 1
        await self.send({'type': 'status', 'state': 'listening'})

    async def stop(self) -> None:
        if self.start is not None:
            await self._final(self.start, len(self.buffer))
        await self.send({'type': 'done'})

    def _trim(self) -> None:
        # Keep memory flat on long sessions: drop audio no open utterance can need.
        keep_from = self.start if self.start is not None else max(0, len(self.buffer) - int(PRE_ROLL * SAMPLE_RATE))
        if keep_from > 30 * SAMPLE_RATE:
            self.buffer = self.buffer[keep_from:]
            if self.start is not None:
                self.start -= keep_from
            self.last_partial_at = max(0, self.last_partial_at - keep_from)
            self.dropped += keep_from
