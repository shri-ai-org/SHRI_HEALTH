"""
The teleconsult transcript API, mounted at /tele on the speech service (app.py).

Dictation keeps nothing; a teleconsult the patient agreed to record keeps its
transcript here, so it can be downloaded later and reconciled with the official
Google Meet transcript.

  GET  /tele/health                         the store is open
  PUT  /tele/sessions/{id}                  create or update a session (patientId, meetUri, meetCode, consent, startedAt, endedAt)
  POST /tele/sessions/{id}/segments         add live transcript lines ({"segments": [...]}); a line already stored is ignored
  PUT  /tele/sessions/{id}/official         the official Meet transcript and the reconciled one
  GET  /tele/sessions/{id}                  the session, its lines, and the official transcript if fetched
  GET  /tele/sessions?patientId=…           a patient's sessions, newest first

It holds patients' conversations, so it FAILS CLOSED: it serves nothing unless
ASR_ORIGINS and ASR_TOKEN are both set, and then only to a browser on one of
those origins (a request with no Origin is refused) carrying the token (as
?token= or the X-Shri-Token header, compared in constant time). CORS is never
"*". For development on one machine, TELE_DEV=1 opens it to pages served from
localhost / 127.0.0.1 only, without a token.

The token travels in the browser bundle, so it keeps out other sites and
casual callers — it is not a person's login. Per-user authentication, with
each session scoped to the doctor who recorded it, comes with the backend
platform; until then this store should not be reachable from the internet.
"""

from __future__ import annotations

import hmac
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import SETTINGS

from .store import Store

SID = Path(..., pattern=r'^[A-Za-z0-9._:-]{1,120}$')

# Development on one machine only: pages served from localhost, no token.
DEV = os.getenv('TELE_DEV', '') == '1'
LOCAL_ORIGIN = r'^https?://(localhost|127\.0\.0\.1)(:\d+)?$'
CONFIGURED = bool(SETTINGS.origins and SETTINGS.token)

tele = FastAPI(title='Shri Health teleconsult transcripts')
tele.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.origins),
    allow_origin_regex=LOCAL_ORIGIN if DEV and not CONFIGURED else None,
    allow_methods=['GET', 'PUT', 'POST'],
    allow_headers=['Content-Type', 'X-Shri-Token'],
)

_store: dict = {}


def store() -> Store:
    if 'store' not in _store:
        _store['store'] = Store()
    return _store['store']


def _token_ok(request: Request) -> bool:
    given = request.headers.get('x-shri-token') or request.query_params.get('token') or ''
    return hmac.compare_digest(given.encode(), SETTINGS.token.encode())


@tele.middleware('http')
async def guard(request: Request, call_next):
    if request.method != 'OPTIONS':
        origin = request.headers.get('origin', '')
        if CONFIGURED:
            if origin not in SETTINGS.origins:
                return JSONResponse({'detail': 'origin not allowed'}, status_code=403)
            if not _token_ok(request):
                return JSONResponse({'detail': 'token required'}, status_code=401)
        elif DEV:
            import re

            if origin and not re.match(LOCAL_ORIGIN, origin):
                return JSONResponse({'detail': 'origin not allowed'}, status_code=403)
        else:
            return JSONResponse({'detail': 'the transcript store is closed: set ASR_ORIGINS and ASR_TOKEN (or TELE_DEV=1 on a development machine)'}, status_code=503)
    return await call_next(request)


class SessionIn(BaseModel):
    patientId: str | None = Field(None, max_length=80)
    encounterId: str | None = Field(None, max_length=80)
    meetUri: str | None = Field(None, max_length=300)
    meetCode: str | None = Field(None, max_length=40)
    consent: Literal['given', 'declined'] | None = None
    startedAt: int | None = None
    endedAt: int | None = None


class Segment(BaseModel):
    id: str = Field(..., max_length=80)
    speaker: Literal['doctor', 'patient', 'call']
    text: str = Field(..., max_length=8000)
    startMs: int
    endMs: int
    source: Literal['shri-asr', 'browser']


class SegmentsIn(BaseModel):
    segments: list[Segment] = Field(..., max_length=1000)


class OfficialIn(BaseModel):
    source: Literal['meet-api', 'upload']
    entries: list[dict] = Field(..., max_length=20000)
    reconciled: list[dict] = Field(..., max_length=40000)


@tele.get('/health')
def health():
    return {'ok': True, 'db': store().path.name}


@tele.put('/sessions/{sid}')
def put_session(body: SessionIn, sid: str = SID):
    fields = {
        k: v
        for k, v in {
            'patient_id': body.patientId,
            'encounter_id': body.encounterId,
            'meet_uri': body.meetUri,
            'meet_code': body.meetCode,
            'consent': body.consent,
            'started_at': body.startedAt,
            'ended_at': body.endedAt,
        }.items()
        if v is not None
    }
    try:
        return store().upsert_session(sid, fields)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e


@tele.post('/sessions/{sid}/segments')
def post_segments(body: SegmentsIn, sid: str = SID):
    try:
        count = store().add_segments(sid, [s.model_dump() for s in body.segments])
    except KeyError as e:
        raise HTTPException(404, 'No such session.') from e
    return {'stored': count}


@tele.put('/sessions/{sid}/official')
def put_official(body: OfficialIn, sid: str = SID):
    try:
        store().put_official(sid, body.source, body.entries, body.reconciled)
    except KeyError as e:
        raise HTTPException(404, 'No such session.') from e
    return {'ok': True}


@tele.get('/sessions/{sid}')
def get_session(sid: str = SID):
    s = store().session(sid)
    if s is None:
        raise HTTPException(404, 'No such session.')
    return {'session': s, 'segments': store().segments(sid), 'official': store().official(sid)}


@tele.get('/sessions')
def list_sessions(patientId: str = Query(..., max_length=80)):
    return {'sessions': store().sessions_for(patientId)}
