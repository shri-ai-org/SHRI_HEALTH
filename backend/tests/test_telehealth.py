"""The teleconsult transcript store and its API, on a throwaway database. Run: python -m pytest tests -q."""

from fastapi.testclient import TestClient

import app as service
from telehealth import api
from telehealth.store import Store


def client(tmp_path):
    api._store['store'] = Store(tmp_path / 'tele.sqlite3')
    return TestClient(service.app)


def line(i, speaker='doctor', text='hello'):
    return {'id': f's{i}', 'speaker': speaker, 'text': text, 'startMs': 1000 * i, 'endMs': 1000 * i + 900, 'source': 'shri-asr'}


def test_a_session_keeps_its_lines_once_each_in_order(tmp_path):
    c = client(tmp_path)
    r = c.put('/tele/sessions/T1', json={'patientId': 'SD-1', 'meetCode': 'abc-defg-hij', 'consent': 'given', 'startedAt': 5})
    assert r.status_code == 200 and r.json()['meetCode'] == 'abc-defg-hij'
    assert c.post('/tele/sessions/T1/segments', json={'segments': [line(2), line(1, 'patient')]}).json() == {'stored': 2}
    # A retry after a dropped connection sends a line again: it is stored once.
    assert c.post('/tele/sessions/T1/segments', json={'segments': [line(2), line(3)]}).json() == {'stored': 3}
    got = c.get('/tele/sessions/T1').json()
    assert [s['id'] for s in got['segments']] == ['s1', 's2', 's3']
    assert got['segments'][0]['speaker'] == 'patient'
    assert got['official'] is None


def test_an_update_changes_only_what_it_names(tmp_path):
    c = client(tmp_path)
    c.put('/tele/sessions/T1', json={'patientId': 'SD-1', 'meetUri': 'https://meet.google.com/abc-defg-hij', 'startedAt': 5})
    s = c.put('/tele/sessions/T1', json={'endedAt': 99}).json()
    assert s['meetUri'] == 'https://meet.google.com/abc-defg-hij' and s['startedAt'] == 5 and s['endedAt'] == 99
    assert [x['id'] for x in c.get('/tele/sessions', params={'patientId': 'SD-1'}).json()['sessions']] == ['T1']


def test_lines_need_a_session_and_a_session_needs_its_patient(tmp_path):
    c = client(tmp_path)
    assert c.post('/tele/sessions/NOPE/segments', json={'segments': [line(1)]}).status_code == 404
    assert c.put('/tele/sessions/T2', json={'meetCode': 'x'}).status_code == 422
    assert c.put('/tele/sessions/bad id!', json={'patientId': 'SD-1'}).status_code in (404, 422)


def test_the_official_transcript_is_stored_and_replaced(tmp_path):
    c = client(tmp_path)
    c.put('/tele/sessions/T1', json={'patientId': 'SD-1'})
    c.put('/tele/sessions/T1/official', json={'source': 'upload', 'entries': [{'text': 'a'}], 'reconciled': []})
    c.put('/tele/sessions/T1/official', json={'source': 'meet-api', 'entries': [{'text': 'b'}], 'reconciled': [{'text': 'b'}]})
    off = c.get('/tele/sessions/T1').json()['official']
    assert off['source'] == 'meet-api' and off['entries'] == [{'text': 'b'}]


def test_the_store_survives_a_restart(tmp_path):
    Store(tmp_path / 'tele.sqlite3').upsert_session('T1', {'patient_id': 'SD-1'})
    again = Store(tmp_path / 'tele.sqlite3')
    again.add_segments('T1', [line(1)])
    assert again.session('T1')['patientId'] == 'SD-1' and len(again.segments('T1')) == 1
