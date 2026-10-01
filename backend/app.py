"""
Shri Health speech service — Tamil and English spoken, English written.

  GET  /health          the engine, model, device and denoiser in use
  WS   /ws/transcribe   one dictation session (see asr/pipeline.py)

Protocol, client → server:
  text   {"type": "start"}            opens a session (optional: the first audio opens one too)
  binary 16 kHz mono Int16 PCM        about 250 ms per frame
  text   {"type": "stop"}             flushes the last utterance, then the server sends "done"
Server → client:
  {"type": "ready"}                                    the engine is loaded and listening
  {"type": "partial", "text": "...", "is_final": false}  live, about every second of speech
  {"type": "final", "id": n, "text": "...", "is_final": true}  at each pause — replaces the partials
  {"type": "status", "state": "processing" | "listening"}
  {"type": "error", "message": "..."}
  {"type": "done"}

No database and nothing on disk: audio lives in memory for the session and is
dropped when the socket closes.

Run:  uvicorn app:app --host 127.0.0.1 --port 8765   (from backend/, inside .venv)
"""

from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from asr.engines import load_engine
from asr.pipeline import Session
from audio.denoise import status as denoise_status
from config import SETTINGS

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(name)s %(levelname)s %(message)s')
log = logging.getLogger('asr.app')

ENGINE: dict = {}

# A session longer than this is ended — one dictation, not an open microphone.
MAX_SESSION_SECONDS = 15 * 60


@asynccontextmanager
async def lifespan(_: FastAPI):
    ENGINE['engine'] = await asyncio.to_thread(load_engine)
    denoise_status()  # load DeepFilterNet up front, or learn now that it is unavailable
    yield


app = FastAPI(title='Shri Health speech service', lifespan=lifespan)


@app.get('/health')
def health():
    engine = ENGINE.get('engine')
    return {'ok': engine is not None, **(engine.describe() if engine else {}), 'denoise': denoise_status(), 'partials': SETTINGS.partials}


@app.websocket('/ws/transcribe')
async def transcribe(ws: WebSocket):
    origin = ws.headers.get('origin', '')
    if SETTINGS.origins and origin not in SETTINGS.origins:
        await ws.close(code=4403)
        return
    if SETTINGS.token and ws.query_params.get('token') != SETTINGS.token:
        await ws.close(code=4401)
        return
    await ws.accept()
    engine = ENGINE.get('engine')
    if engine is None:
        await ws.send_json({'type': 'error', 'message': 'The speech engine is still loading.'})
        await ws.close()
        return

    lock = asyncio.Lock()

    async def send(msg: dict):
        async with lock:
            try:
                await ws.send_json(msg)
            except RuntimeError:
                pass  # the client has gone

    session = Session(engine=engine, send=send)
    await send({'type': 'ready'})
    loop = asyncio.get_running_loop()
    deadline = loop.time() + MAX_SESSION_SECONDS
    try:
        while True:
            # asyncio.timeout() is Python 3.11+; the server runs 3.10, so the deadline is kept by hand.
            msg = await asyncio.wait_for(ws.receive(), timeout=max(0.1, deadline - loop.time()))
            if msg['type'] == 'websocket.disconnect':
                break
            if msg.get('bytes') is not None:
                await session.feed(msg['bytes'])
            elif msg.get('text'):
                kind = json.loads(msg['text']).get('type')
                if kind == 'stop':
                    await session.stop()
                    break
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception as e:  # pragma: no cover
        log.exception('session failed')
        await send({'type': 'error', 'message': f'Transcription stopped: {e.__class__.__name__}'})
    finally:
        try:
            await ws.close()
        except RuntimeError:
            pass


if __name__ == '__main__':
    import uvicorn

    uvicorn.run(app, host=SETTINGS.host, port=SETTINGS.port)
