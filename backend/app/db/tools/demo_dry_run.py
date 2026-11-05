"""The demo visit's dry run (D108): its 7 steps through the API, each reported as pass or fail
with the reason. Synthetic data only: it registers one new synthetic patient each run.

    python -m app.db.tools.demo_dry_run --base-url http://127.0.0.1:8000

It is an HTTP client only: it never touches the database, and it changes nothing the API
wouldn't let a user change. Exit code 0 when every step passes, 1 otherwise.

**Which stack.** Any API that accepts core's development sign-in (``AUTH_MODE=dev_header``,
the ``X-Dev-User`` header: ``fd``, ``ma``, ``md``), which settings allow only in development and
test. The test server uses real sign-in, so this script doesn't run against it yet.

**After a reset** (``python -m app.db.seed reset`` on an empty database, or ``deploy.sh reset``):
the demo layer is enough for steps 1 to 4. Steps 5 and 6 also need the code releases loaded
(``python -m app.db.terminology icd10cm …`` and ``… rxnorm …``); without them they fail with
"no codes loaded". The seed's all-day schedules give free times from today, so the visit is
booked today, at the first free time at least 5 minutes ahead. The revisit is booked exactly 14
days after the visit, in the facility's time zone, with the same provider; it fails, and says
so, if that day has no free time (the demo seed's weekly all-day rules have no end date).

**The local difference: encryption.** The after-visit summary is stored encrypted and
idempotent replies are kept encrypted, both through core's OpenBao Transit. The test server
runs a real OpenBao. A laptop without one must start the API with an in-memory Transit
stand-in (never on a server), or step 7's summary fails. The summary's download link is also
signed with ``SESSION_SECRET``, which every server sets; a laptop sets a random one per run, or
step 7 answers ``503 Downloads are not configured``. Nothing else differs.

**Time of day.** Check-in is same-day only in the facility's time zone: late in the evening
there, when no free time is left that day, step 2 fails and says so. Run it after midnight
there.
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from zoneinfo import ZoneInfo

import httpx

API = "/api/v1"
ICD10CM = "http://hl7.org/fhir/sid/icd-10-cm"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
#: The revisit is booked exactly this many days after the visit, in the facility's time zone.
REVISIT_DAYS = 14
STEPS = {1: "register the patient", 2: "book", 3: "check in", 4: "room",
         5: "doctor: diagnosis and signed note", 6: "prescribe and send",
         7: "check-out: follow-up, summary, revisit"}


class StepFailed(Exception):
    """The step's first refusal, as the reason to report."""


@dataclass
class Visit:
    """What each step leaves for the next."""
    tag: str = field(default_factory=lambda: uuid.uuid4().hex[:6])
    patient: str = ""
    facility: str = ""
    zone: str = "UTC"
    provider: str = ""
    visit_type: str = ""
    start: str = ""
    appointment: str = ""
    encounter: str = ""
    note: str = ""


class Client:
    def __init__(self, base_url: str, transport: httpx.BaseTransport | None = None) -> None:
        self._http = httpx.Client(base_url=base_url.rstrip("/") + API, timeout=60,
                                  transport=transport)

    def call(self, who: str, method: str, path: str, body: Any = None,
             expect: tuple[int, ...] = (200, 201), etag: str | None = None,
             merge_patch: bool = False) -> httpx.Response:
        headers = {"X-Dev-User": who}
        if method in ("POST", "PUT", "PATCH"):
            headers["Idempotency-Key"] = str(uuid.uuid4())
        if etag is not None:
            headers["If-Match"] = etag
        if merge_patch:
            headers["Content-Type"] = "application/merge-patch+json"
        r = self._http.request(method, path, headers=headers,
                               **({"json": body} if body is not None else {}))
        if r.status_code not in expect:
            raise StepFailed(f"{method} {_template(path)} answered {r.status_code} "
                             f"{_problem(r)}")
        return r

    def wait(self, accepted: httpx.Response, who: str, limit: float = 60) -> None:
        """Follows a 202's ``Location`` (core's long-running operation) until it ends, within
        ``limit`` seconds, at its own ``Retry-After`` pace."""
        location = accepted.headers.get("location", "")
        path = location.split(API, 1)[-1] if API in location else location
        waited = 0.0
        while path:
            status = self.call(who, "GET", path).json().get("status")
            if status == "succeeded":
                return
            if status in ("failed", "cancelled"):
                raise StepFailed(f"the operation behind {_template(path)} {status}")
            if waited >= limit:
                raise StepFailed(f"the operation behind {_template(path)} is still {status} "
                                 f"after {limit:.0f} s")
            pause = float(accepted.headers.get("retry-after", "1"))
            time.sleep(pause)
            waited += pause
        if not path:
            raise StepFailed("a 202 without a Location to follow")

    def close(self) -> None:
        self._http.close()


def _template(path: str) -> str:
    parts = path.split("?")[0].split("/")
    return "/".join("{id}" if _is_uuid(p) else p for p in parts)


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True


def _problem(r: httpx.Response) -> str:
    """The Problem Details code and the pointers it names, never the body's values."""
    try:
        js = r.json()
    except ValueError:
        return ""
    if not isinstance(js, dict):
        return ""
    errors = [f"{e.get('pointer')}:{e.get('code')}" for e in js.get("errors") or []]
    return " ".join([str(js.get("code") or ""), *errors]).strip()


def _items(r: httpx.Response) -> list[Any]:
    js = r.json()
    items = js.get("items") if isinstance(js, dict) else js
    return items if isinstance(items, list) else []


def _first_code(c: Client, system: str, query: str, what: str) -> dict[str, Any]:
    found = _items(c.call("md", "GET", f"/codes?system={system}&q={query}"))
    if not found:
        raise StepFailed(f"no {what} codes loaded (python -m app.db.terminology)")
    match: dict[str, Any] = found[0]
    return match


def _free_time(c: Client, v: Visit, day: dt.date, after: dt.datetime) -> str | None:
    r = c.call("fd", "GET", f"/slots?date={day}&facilityId={v.facility}"
               f"&providerId={v.provider}&appointmentTypeId={v.visit_type}")
    for slot in _items(r):
        if dt.datetime.fromisoformat(slot["startAt"].replace("Z", "+00:00")) > after:
            start: str = slot["startAt"]
            return start
    return None


# ------------------------------------------------------------------ the steps (D108)
def register(c: Client, v: Visit) -> str:
    # A new synthetic person each run (Synthea-style digits, D112), so runs never match each other.
    family = f"Dryrun{int(v.tag, 16) % 1000}"
    born = (dt.date(1950, 1, 1) + dt.timedelta(days=int(v.tag, 16) % 18000)).isoformat()
    person = {"name": {"family": family, "given": [f"Synth{v.tag}"]},
              "birthDate": born, "gender": "female", "birthSex": "F"}
    c.call("fd", "POST", "/patients/search", {"criteria": {"family": family, "birthDate": born}})
    js = c.call("fd", "POST", "/patients", person, expect=(201,)).json()
    v.patient = js["id"]
    c.call("fd", "POST", "/patients", person, expect=(409,))      # the duplicate check
    return "registered, the same person again is a possible duplicate (409)"


def book(c: Client, v: Visit) -> str:
    """Check-in is same-day only, in the facility's own time zone: the visit is booked at the
    first facility and provider with a free time left today there."""
    facilities = _items(c.call("fd", "GET", "/booking/facilities"))
    types = _items(c.call("fd", "GET", "/booking/appointment-types"))
    if not (facilities and types):
        raise StepFailed("no facility or visit type to book (seed the demo layer)")
    v.visit_type = types[0]["id"]
    soon = dt.datetime.now(dt.UTC) + dt.timedelta(minutes=5)
    start = None
    for facility in facilities:
        v.facility, v.zone = facility["id"], facility["timeZone"]
        today = soon.astimezone(ZoneInfo(v.zone)).date()
        for provider in _items(c.call("fd", "GET", f"/booking/providers?facilityId={v.facility}")):
            v.provider = provider["id"]
            if start := _free_time(c, v, today, soon):
                break
        if start:
            break
    if start is None:
        raise StepFailed("no free time left today at any facility (check-in is same-day only, "
                         "in the facility's time zone): run it again after midnight there")
    js = c.call("fd", "POST", "/appointments", {
        "patientId": v.patient, "providerId": v.provider, "facilityId": v.facility,
        "appointmentTypeId": v.visit_type, "startAt": start,
        "reasonForVisit": "Cough for 5 days (synthetic)"}, expect=(201,)).json()
    v.appointment, v.start = js["id"], start
    return f"booked at {start}"


def check_in(c: Client, v: Visit) -> str:
    js = c.call("fd", "POST", f"/appointments/{v.appointment}/check-in",
                {"selfPay": True}).json()
    v.encounter = js["encounterId"]
    board = _items(c.call("fd", "GET", f"/status-board?facilityId={v.facility}"
                          f"&date={v.start[:10]}"))
    if not any(row.get("appointmentId") == v.appointment for row in board):
        raise StepFailed("checked in, but the visit isn't on the status board")
    return "checked in; on the status board"


def room(c: Client, v: Visit) -> str:
    rooms = [loc for loc in _items(c.call("ma", "GET",
                                          f"/booking/locations?facilityId={v.facility}"))
             if loc.get("physicalType") == "ro"]
    if not rooms:
        raise StepFailed("no room at the visit's facility to put the patient in")
    c.call("ma", "POST", f"/appointments/{v.appointment}/status",
           {"status": "roomed", "roomLocationId": rooms[0]["id"]})
    c.call("ma", "POST", f"/encounters/{v.encounter}/vitals", {"entries": [
        {"type": "blood-pressure", "bloodPressure": {
            "systolic": {"value": 128, "unit": "mm[Hg]"},
            "diastolic": {"value": 82, "unit": "mm[Hg]"}}},
        {"type": "heart-rate", "value": {"value": 76, "unit": "/min"}},
        {"type": "body-temperature", "value": {"value": 37.9, "unit": "Cel"}}]})
    c.call("ma", "POST", f"/patients/{v.patient}/allergies", {
        "code": {"text": "Latex (synthetic)"}, "type": "allergy", "categories": ["environment"],
        "criticality": "low", "clinicalStatus": "active", "verificationStatus": "confirmed",
        "encounterId": v.encounter})
    c.call("ma", "POST", f"/patients/{v.patient}/medications", {
        "medication": {"text": "Lisinopril 10 mg tablet"}, "dosageText": "1 tablet daily"})
    etag = c.call("ma", "GET", f"/encounters/{v.encounter}").headers["etag"]
    c.call("ma", "PATCH", f"/encounters/{v.encounter}",
           {"reasons": [{"text": "Cough for 5 days"}]}, etag=etag, merge_patch=True)
    return "roomed: vitals, an allergy, a current medication, the reason for visit"


def doctor(c: Client, v: Visit) -> str:
    code = _first_code(c, "icd-10-cm", "J20.9", "ICD-10-CM")
    c.call("md", "POST", f"/encounters/{v.encounter}/diagnoses", {
        "code": {"system": ICD10CM, "code": code["code"], "display": code.get("display")},
        "rank": 1, "verificationStatus": "confirmed"}, expect=(201,))
    templates = _items(c.call("md", "GET", "/note-templates"))
    body: dict[str, Any] = {"title": "Office visit"}
    if templates:
        body["templateId"] = templates[0]["id"]
    r = c.call("md", "POST", f"/encounters/{v.encounter}/notes", body, expect=(201,))
    v.note, sections = r.json()["id"], r.json().get("sections") or []
    etag = r.headers["etag"]
    if sections:
        etag = c.call("md", "PATCH", f"/notes/{v.note}", {"sections": [
            {"id": s["id"], "text": "Synthetic dry-run text."} for s in sections]},
            etag=etag, merge_patch=True).headers["etag"]
    etag = c.call("md", "POST", f"/notes/{v.note}/sign", {}, etag=etag).headers["etag"]
    c.call("md", "POST", f"/notes/{v.note}/addenda",
           {"text": "Addendum: patient called back (synthetic)."}, etag=etag)
    return f"diagnosis {code['code']}; templated note signed, with an addendum"


def prescribe(c: Client, v: Visit) -> str:
    drug = _first_code(c, "rxnorm", "amoxicillin%20500", "RxNorm")
    pharmacies = _items(c.call("md", "GET", "/pharmacies"))
    if not pharmacies:
        raise StepFailed("no active pharmacy in the directory")
    r = c.call("md", "POST", "/prescriptions", {
        "patientId": v.patient, "encounterId": v.encounter,
        "medication": {"codings": [{"system": RXNORM, "code": drug["code"]}]},
        "dosageText": "1 capsule three times daily for 7 days", "daysSupply": 7, "refills": 0,
        "quantity": {"value": 21, "unit": "capsule"}, "pharmacyId": pharmacies[0]["id"]},
        expect=(201,))
    rx = r.json()["id"]
    alerts = c.call("md", "POST", f"/prescriptions/{rx}/safety-check", {}).json()
    for alert in alerts.get("alerts") or []:
        if alert.get("overrideRequired"):
            c.call("md", "POST", f"/alerts/{alert['id']}/override",
                   {"reason": "Discussed with the patient (synthetic)."})
    etag = c.call("md", "GET", f"/prescriptions/{rx}").headers["etag"]
    js = c.call("md", "POST", f"/prescriptions/{rx}/sign-and-send", {}, etag=etag).json()
    sent = (js.get("status"), (js.get("transmission") or {}).get("status"))
    if sent != ("active", "queued"):
        raise StepFailed(f"signed, but status and transmission are {sent}")
    return (f"{drug.get('display') or drug['code']}: checked "
            f"({len(alerts.get('alerts') or [])} alerts), signed, NewRx queued")


def check_out(c: Client, v: Visit) -> str:
    etag = c.call("md", "GET", f"/encounters/{v.encounter}").headers["etag"]
    c.call("md", "PUT", f"/encounters/{v.encounter}/follow-up",
           {"interval": {"value": 2, "unit": "week"}}, etag=etag)
    made = c.call("md", "POST", f"/encounters/{v.encounter}/after-visit-summary",
                  {"noteId": v.note}, expect=(202,))
    c.wait(made, "md")
    c.call("fd", "GET", f"/encounters/{v.encounter}/after-visit-summary/download-url")
    visit_day = dt.datetime.fromisoformat(v.start.replace("Z", "+00:00")).astimezone(
        ZoneInfo(v.zone)).date()
    revisit_day = visit_day + dt.timedelta(days=REVISIT_DAYS)    # the follow-up's 2 weeks
    start = _free_time(c, v, revisit_day, dt.datetime.now(dt.UTC))
    if start is None:
        raise StepFailed(f"no free time on {revisit_day}, {REVISIT_DAYS} days out, for the "
                         "visit's provider (the demo seed's weekly all-day rules give some)")
    c.call("fd", "POST", "/appointments", {
        "patientId": v.patient, "providerId": v.provider, "facilityId": v.facility,
        "appointmentTypeId": v.visit_type, "startAt": start,
        "reasonForVisit": "Follow-up (synthetic)", "followUpOfEncounterId": v.encounter},
        expect=(201,))
    c.call("fd", "POST", f"/appointments/{v.appointment}/check-out", {})
    return f"follow-up asked, summary printed, revisit booked at {start}, checked out"


ORDER: tuple[Callable[[Client, Visit], str], ...] = (
    register, book, check_in, room, doctor, prescribe, check_out)


def run(base_url: str, transport: httpx.BaseTransport | None = None
        ) -> list[tuple[int, bool, str]]:
    """Runs the steps in order. A step that fails stops the ones after it (they'd need its
    patient, visit or note), which are reported as not run."""
    c, v, results = Client(base_url, transport), Visit(), []
    try:
        for n, step in enumerate(ORDER, start=1):
            try:
                results.append((n, True, step(c, v)))
            except StepFailed as failed:
                results.append((n, False, str(failed)))
                results += [(m, False, f"not run: needs step {n}")
                            for m in range(n + 1, len(ORDER) + 1)]
                break
            except httpx.HTTPError as error:
                results.append((n, False, f"the API can't be reached: {type(error).__name__}"))
                break
    finally:
        c.close()
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.db.tools.demo_dry_run",
                                     description=__doc__.split("\n\n")[0])
    parser.add_argument("--base-url", default="http://127.0.0.1:8000",
                        help="the API, without /api/v1 (default %(default)s)")
    args = parser.parse_args(argv)
    results = run(args.base_url)
    for n, ok, reason in results:
        print(f"{n}. {STEPS[n]:40} {'PASS' if ok else 'FAIL'}  {reason}")
    return 0 if len(results) == len(ORDER) and all(ok for _, ok, _ in results) else 1


if __name__ == "__main__":
    sys.exit(main())
