"""
Streams a WAV to the speech service as a microphone would — 250 ms of 16 kHz
Int16 at a time, in real time — and prints every partial and final with how long
after the start it arrived.

Usage:  python -m tools.stream_file clip.wav [--url ws://127.0.0.1:8765/ws/transcribe] [--fast]
"""

import argparse
import asyncio
import json
import time

import numpy as np
import soundfile as sf
import websockets

FRAME = 4000  # 250 ms at 16 kHz


def to_pcm16(path: str) -> bytes:
    audio, sr = sf.read(path, dtype='float32')
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import torch
        import torchaudio.functional as F

        audio = F.resample(torch.from_numpy(audio), sr, 16000).numpy()
    return (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('wav')
    ap.add_argument('--url', default='ws://127.0.0.1:8765/ws/transcribe')
    ap.add_argument('--fast', action='store_true', help='send as fast as possible, not in real time')
    ap.add_argument('--tail', type=float, default=1.5, help='seconds of silence after the clip, so the last pause closes')
    args = ap.parse_args()

    pcm = to_pcm16(args.wav) + b'\x00\x00' * int(16000 * args.tail)
    t0 = time.time()
    async with websockets.connect(args.url, max_size=None) as ws:

        async def reader():
            async for raw in ws:
                m = json.loads(raw)
                if m['type'] in ('partial', 'final'):
                    print(f'{time.time() - t0:6.2f}s  {m["type"]:7}  {m["text"]}', flush=True)
                elif m['type'] in ('error', 'done'):
                    print(f'{time.time() - t0:6.2f}s  {m["type"]}  {m.get("message", "")}', flush=True)
                    return

        task = asyncio.create_task(reader())
        await ws.send(json.dumps({'type': 'start'}))
        for i in range(0, len(pcm), FRAME * 2):
            await ws.send(pcm[i : i + FRAME * 2])
            if not args.fast:
                await asyncio.sleep(0.25)
        await ws.send(json.dumps({'type': 'stop'}))
        await task
    print(f'audio {len(pcm) / 32000:.1f}s · total {time.time() - t0:.1f}s')


if __name__ == '__main__':
    asyncio.run(main())
