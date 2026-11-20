"""Linda Thompson's secure messages (Sena's demo plan, D119: the portal's secure messaging; the
storage is migration 0031): three threads, so the portal's messages and the medical assistants'
inbox have something to show after every reset.

One table, ``THREADS``, easy to edit. Each thread is stored as the portal stores one (0031's
docstring): an ``admin.work_item`` of type ``patient-message`` for Linda, the subject as its
title, no body, routed to the medical assistants (the platform role ``MA``) at the main office,
priority 4 (routine), open; its ``created`` event; and its messages as ``admin.work_item_reply``
rows, Linda's own (always ``to_patient``) or a demo staff user's.

1. **Answered:** Linda asks how to take naproxen with omeprazole; demo.doctor answers her the
   next morning (``to_patient``).
2. **Unanswered:** Linda asks about cyclobenzaprine drowsiness the evening before the demo day;
   it waits in the medical assistants' queue.
3. **With a staff note:** Linda's back pain after gardening; demo.doctor's internal note to the
   medical assistant (``to_patient`` false: the portal never shows it), then demo.ma's answer
   to her.

All three stay open, so the portal can reply on any of them in the demo. The times are the
clinic's clock on the days before the demo day (``demo.DEMO_DAY``, or today when that is
later), in order, so the portal's "latest activity first" lists thread 2, then 3, then 1.

The seed writes the rows itself, as shri_migrator (0031's guard lets only that role make a
``patient-message`` item), rather than through ``admin.portal_create_message``, because it
needs fixed IDs and past times. It writes no ``event_log`` row: notifications are runtime, and
these are days old. Replies are insert-only, so each row is skipped when its fixed ID exists: a
second run changes nothing. After ``linda``, in its own transaction. Synthetic text only.
"""
from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass

from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.deps import CLINIC_A, FACILITY_A
from app.db.models import MAPPERS
from app.db.seed import demo, starter
from app.db.seed.demo import CLINIC_ZONE, DEMO_USER, PATIENT
from app.db.seed.starter import _ensure, sid

M = MAPPERS

#: Kinds of fixed ID (app/db/CLAUDE.md's table): a thread (n), its created event (n), and its
#: messages (n * 10 + the message's number).
MESSAGE_THREAD, MESSAGE_EVENT, MESSAGE_REPLY = range(66, 69)
N = 3                                       # Linda Thompson
LINDA = sid(PATIENT, N)
MA_USER, DOCTOR_USER = sid(DEMO_USER, 2), sid(DEMO_USER, 3)     # demo.ma, demo.doctor
PRIORITY = 4                                # routine, as the portal routes a new message


@dataclass(frozen=True)
class Message:
    days_before: int                        # days before the anchor day (the demo day)
    at: dt.time                             # the clinic's clock
    body: str
    author: uuid.UUID | None = None         # a demo staff user; None is Linda
    to_patient: bool = True                 # Linda's own are always True

    def sent(self, day: dt.date) -> dt.datetime:
        when = dt.datetime.combine(day - dt.timedelta(days=self.days_before), self.at)
        return when.replace(tzinfo=CLINIC_ZONE)


@dataclass(frozen=True)
class Thread:
    n: int
    subject: str
    messages: tuple[Message, ...]


THREADS = (
    Thread(1, "Taking naproxen and omeprazole together", (
        Message(5, dt.time(19, 10),
                "Hi, should I take the omeprazole at the same time as the naproxen, or "
                "separately? I usually take the naproxen with breakfast."),
        Message(4, dt.time(8, 40),
                "Hi Linda, take the omeprazole each morning about 30 minutes before breakfast, "
                "then the naproxen with your breakfast as you do now. If you get stomach pain or "
                "dark stools, call us right away.", author=DOCTOR_USER),
    )),
    Thread(2, "Cyclobenzaprine makes me drowsy", (
        Message(1, dt.time(20, 35),
                "The cyclobenzaprine makes me quite drowsy the next morning. Is it all right to "
                "take it earlier in the evening, around 7 pm?"),
    )),
    Thread(3, "Back pain worse after gardening", (
        Message(3, dt.time(8, 15),
                "My lower back has been more painful since I did some gardening at the weekend. "
                "The stretches help a little. Should I come in before my next visit?"),
        Message(3, dt.time(12, 5),
                "No numbness, leg weakness or bladder change in her message. Please advise heat "
                "and the home stretches, and book her a follow-up with me if it is no better in "
                "a week.", author=DOCTOR_USER, to_patient=False),
        Message(3, dt.time(13, 20),
                "Hi Linda, the doctor suggests heat for 15 to 20 minutes a few times a day and "
                "keeping up your stretches. If it is no better in a week, reply here and we will "
                "book you in sooner. If you notice numbness, leg weakness or bladder problems, "
                "call us or go to urgent care.", author=MA_USER),
    )),
)


def anchor(now: dt.datetime | None = None) -> dt.date:
    """The day the threads count back from: the demo day, or the clinic's today when the demo
    day is still ahead (SHRI_DEMO_DAY set early), so no message is in the future."""
    today = (now or dt.datetime.now(dt.UTC)).astimezone(CLINIC_ZONE).date()
    return min(demo.DEMO_DAY, today)


def thread_ids() -> tuple[uuid.UUID, ...]:
    return tuple(sid(MESSAGE_THREAD, t.n) for t in THREADS)


def load_messages(db: Session, now: dt.datetime | None = None) -> int:
    """Writes what is missing, in the session's transaction; returns how many threads it
    started (0 on a second run)."""
    starter._set_clinic(db, CLINIC_A)
    role = db.execute(text("SELECT id FROM admin.role WHERE code = 'MA' AND tenant_id IS NULL "
                           "AND is_system")).scalar_one()
    day, started = anchor(now), 0
    for t in THREADS:
        first, last = t.messages[0].sent(day), t.messages[-1].sent(day)
        staff = [m.author for m in t.messages if m.author is not None]
        thread = sid(MESSAGE_THREAD, t.n)
        if db.get(M["work_item"], thread) is None:
            started += 1
        _ensure(db, "work_item", thread, tenant_id=CLINIC_A, item_type="patient-message",
                status="open", priority=PRIORITY, title=t.subject, assigned_role_id=role,
                facility_id=FACILITY_A, escalation_level=0, patient_id=LINDA, created_at=first,
                updated_at=last, updated_by_user_id=staff[-1] if staff else None)
        _ensure(db, "work_item_event", sid(MESSAGE_EVENT, t.n), tenant_id=CLINIC_A,
                work_item_id=thread, event="created", to_status="open", occurred_at=first,
                created_at=first, updated_at=first)
        for i, m in enumerate(t.messages, start=1):
            sent = m.sent(day)
            _ensure(db, "work_item_reply", sid(MESSAGE_REPLY, t.n * 10 + i), tenant_id=CLINIC_A,
                    work_item_id=thread, author_user_id=m.author,
                    author_patient_id=None if m.author else LINDA, body=m.body,
                    to_patient=m.to_patient, created_at=sent, updated_at=sent,
                    created_by_user_id=m.author, updated_by_user_id=m.author)
    return started


def run(engine: Engine) -> int:
    """``load_messages`` in its own transaction, for the seed's callers."""
    with Session(engine) as db, db.begin():
        return load_messages(db)
