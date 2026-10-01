"""
A stand-in for the speech service, with no model — for the browser flows. It speaks
the real protocol (app.py) and answers with a scripted take, timed off the audio it
receives: a partial after 1 s of audio, a revised partial after 2 s, and on Stop a
"processing" status, the final English, then "done".

Usage:  python -m tools.mock_service [--port 8799]
"""

import argparse
import asyncio
import json

import websockets

PARTIALS = [(1.0, 'Blood pressure a little'), (2.0, 'Blood pressure is slightly high')]
FINAL = 'Blood pressure is slightly high, increase the dose.'


async def session(ws):
    await ws.send(json.dumps({'type': 'ready'}))
    seconds = 0.0
    sent = 0
    async for msg in ws:
        if isinstance(msg, (bytes, bytearray)):
            seconds += len(msg) / 32000
            while sent < len(PARTIALS) and seconds >= PARTIALS[sent][0]:
                await ws.send(json.dumps({'type': 'partial', 'text': PARTIALS[sent][1], 'is_final': False}))
                sent += 1
        elif json.loads(msg).get('type') == 'stop':
            await ws.send(json.dumps({'type': 'status', 'state': 'processing'}))
            await asyncio.sleep(0.6)
            await ws.send(json.dumps({'type': 'final', 'id': 1, 'text': FINAL, 'is_final': True}))
            await ws.send(json.dumps({'type': 'done'}))
            return


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8799)
    args = ap.parse_args()
    async with websockets.serve(session, '127.0.0.1', args.port):
        print(f'mock speech service on ws://127.0.0.1:{args.port}/ws/transcribe', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
