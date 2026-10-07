"""
The teleconsult store — one SQLite file, standard library only.

  sessions   one row per teleconsult: who, the Google Meet it ran on, when, consent
  segments   the live transcript, line by line, as the speech service heard it
  official   the official Google Meet transcript and the reconciled one, once fetched

Lines are keyed by the browser's own id, so a line sent twice (a retry after a
dropped connection) is stored once. Nothing here is ever deleted by the service.

The file is TELE_DB (default backend/data/telehealth.sqlite3).
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / 'data' / 'telehealth.sqlite3'

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  patient_id   TEXT NOT NULL,
  encounter_id TEXT,
  meet_uri     TEXT,
  meet_code    TEXT,
  consent      TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_patient ON sessions(patient_id);
CREATE TABLE IF NOT EXISTS segments (
  session_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  speaker    TEXT NOT NULL,
  text       TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  source     TEXT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE TABLE IF NOT EXISTS official (
  session_id  TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  entries     TEXT NOT NULL,
  reconciled  TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);
"""

SESSION_FIELDS = ('patient_id', 'encounter_id', 'meet_uri', 'meet_code', 'consent', 'started_at', 'ended_at')


class Store:
    def __init__(self, path: str | os.PathLike | None = None):
        self.path = Path(path or os.getenv('TELE_DB') or DEFAULT_PATH)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(self.path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute('PRAGMA journal_mode=WAL')
        self._db.executescript(SCHEMA)

    def upsert_session(self, sid: str, fields: dict) -> dict:
        """Creates the session, or updates only the fields given (an absent field keeps its value)."""
        now = int(time.time() * 1000)
        given = {k: fields[k] for k in SESSION_FIELDS if k in fields}
        with self._lock, self._db:
            row = self._db.execute('SELECT id FROM sessions WHERE id = ?', (sid,)).fetchone()
            if row is None:
                if not given.get('patient_id'):
                    raise ValueError('A new session needs its patient.')
                cols = ['id', *given, 'updated_at']
                self._db.execute(f'INSERT INTO sessions ({", ".join(cols)}) VALUES ({", ".join("?" for _ in cols)})', (sid, *given.values(), now))
            elif given:
                sets = ', '.join(f'{k} = ?' for k in given)
                self._db.execute(f'UPDATE sessions SET {sets}, updated_at = ? WHERE id = ?', (*given.values(), now, sid))
        return self.session(sid)

    def session(self, sid: str) -> dict | None:
        row = self._db.execute('SELECT * FROM sessions WHERE id = ?', (sid,)).fetchone()
        return _session(row) if row else None

    def sessions_for(self, patient_id: str) -> list[dict]:
        rows = self._db.execute('SELECT * FROM sessions WHERE patient_id = ? ORDER BY started_at DESC', (patient_id,)).fetchall()
        return [_session(r) for r in rows]

    def add_segments(self, sid: str, segments: list[dict]) -> int:
        """Adds the lines this store has not seen; a line it has (same id) is left as it is. Returns the session's line count."""
        with self._lock, self._db:
            if self._db.execute('SELECT 1 FROM sessions WHERE id = ?', (sid,)).fetchone() is None:
                raise KeyError(sid)
            self._db.executemany(
                'INSERT OR IGNORE INTO segments (session_id, id, speaker, text, start_ms, end_ms, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [(sid, s['id'], s['speaker'], s['text'], int(s['startMs']), int(s['endMs']), s['source']) for s in segments],
            )
            self._db.execute('UPDATE sessions SET updated_at = ? WHERE id = ?', (int(time.time() * 1000), sid))
            return self._db.execute('SELECT COUNT(*) FROM segments WHERE session_id = ?', (sid,)).fetchone()[0]

    def segments(self, sid: str) -> list[dict]:
        rows = self._db.execute('SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, id', (sid,)).fetchall()
        return [{'id': r['id'], 'speaker': r['speaker'], 'text': r['text'], 'startMs': r['start_ms'], 'endMs': r['end_ms'], 'source': r['source']} for r in rows]

    def put_official(self, sid: str, source: str, entries: list, reconciled: list) -> None:
        with self._lock, self._db:
            if self._db.execute('SELECT 1 FROM sessions WHERE id = ?', (sid,)).fetchone() is None:
                raise KeyError(sid)
            self._db.execute(
                'INSERT INTO official (session_id, source, entries, reconciled, fetched_at) VALUES (?, ?, ?, ?, ?) '
                'ON CONFLICT(session_id) DO UPDATE SET source = excluded.source, entries = excluded.entries, reconciled = excluded.reconciled, fetched_at = excluded.fetched_at',
                (sid, source, json.dumps(entries), json.dumps(reconciled), int(time.time() * 1000)),
            )

    def official(self, sid: str) -> dict | None:
        row = self._db.execute('SELECT * FROM official WHERE session_id = ?', (sid,)).fetchone()
        if row is None:
            return None
        return {'source': row['source'], 'entries': json.loads(row['entries']), 'reconciled': json.loads(row['reconciled']), 'fetchedAt': row['fetched_at']}


def _session(r: sqlite3.Row) -> dict:
    return {
        'id': r['id'],
        'patientId': r['patient_id'],
        'encounterId': r['encounter_id'],
        'meetUri': r['meet_uri'],
        'meetCode': r['meet_code'],
        'consent': r['consent'],
        'startedAt': r['started_at'],
        'endedAt': r['ended_at'],
        'updatedAt': r['updated_at'],
    }
