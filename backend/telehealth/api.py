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

Guarded like the socket: the same ASR_ORIGINS and, where set, ASR_TOKEN (as
?token= or the X-Shri-Token header).
"""

from __future__ import annotations

from typing import Literal

from fastapi import FastAPI, HTTPException, Path, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import SETTINGS

from .store import Store

SID = Path(..., pattern=r'^[A-Za-z0-9._:-]{1,120}$')

tele = FastAPI(title='Shri Health teleconsult transcripts')
tele.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.origins) or ['*'],
    allow_methods=['GET', 'PUT', 'POST'],
    allow_headers=['Content-Type', 'X-Shri-Token'],
)

_store: dict = {}


def store() -> Store:
    if 'store' not in _store:
        _store['store'] = Store()
    return _store['store']


@tele.middleware('http')
async def guard(request: Request, call_next):
    if request.method != 'OPTIONS':
        origin = request.headers.get('origin', '')
        if SETTINGS.origins and origin and origin not in SETTINGS.origins:
            return JSONResponse({'detail': 'origin not allowed'}, status_code=403)
        if SETTINGS.token and SETTINGS.token not in (request.query_params.get('token'), request.headers.get('x-shri-token')):
            return JSONResponse({'detail': 'token required'}, status_code=401)
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
