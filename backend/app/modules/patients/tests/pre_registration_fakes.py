"""In-memory stand-ins for online pre-registration (D96): the table and its submit function (#101),
core's public-form guards (T47) and field encryption (#102). They behave like the real pieces
where the API depends on it: the clinic comes only from the practice's code, a replay changes
nothing, a reused key with another body is refused, each clinic sees only its own requests.
Synthetic data only.
"""

from __future__ import annotations

import base64
import hashlib
import json
import operator
from collections import Counter
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from app.core.errors import NotFound

from ..pre_registration_repository import (
    IdempotencyKeyReused,
    PreRegistrationRow,
    Submission,
    UnknownPracticeLink,
)

PORTAL_ORIGIN = "https://portal.example.test"


@dataclass
class FakePreRegistrations:
    links: dict[str, UUID] = field(default_factory=dict)  # practice code -> clinic
    rows: dict[UUID, dict[UUID, PreRegistrationRow]] = field(default_factory=dict)
    keys: dict[tuple[UUID, UUID], str] = field(default_factory=dict)  # (clinic, key) -> hash
    submissions: list[Submission] = field(default_factory=list)
    clock: datetime = datetime(2035, 1, 8, 9, 0, tzinfo=UTC)

    def clinic(self, db: Any) -> dict[UUID, PreRegistrationRow]:
        return self.rows.setdefault(db.tenant_id, {})

    async def submit(self, db: Any, submission: Submission) -> None:
        self.submissions.append(submission)
        clinic = self.links.get(submission.practice_code)
        if clinic is None:
            raise UnknownPracticeLink()
        known = self.keys.get((clinic, submission.idempotency_key))
        if known is not None:
            if known != submission.request_hash:
                raise IdempotencyKeyReused()
            return
        self.keys[(clinic, submission.idempotency_key)] = submission.request_hash
        self.clock += timedelta(minutes=1)
        row = PreRegistrationRow(id=uuid4(), status="pending", details=submission.details,
                                 submitted_at=self.clock)
        self.rows.setdefault(clinic, {})[row.id] = row

    async def list(self, db: Any, status: str, *, limit: int, offset: int
                   ) -> list[PreRegistrationRow]:
        mine = sorted((r for r in self.clinic(db).values() if r.status == status),
                      key=operator.attrgetter("submitted_at", "id"))
        return mine[offset:offset + limit]

    async def get(self, db: Any, pre_registration_id: UUID, *, lock: bool = False
                  ) -> PreRegistrationRow:
        found = self.clinic(db).get(pre_registration_id)
        if found is None:
            raise NotFound()
        return found

    async def accept(self, db: Any, pre_registration_id: UUID, *, user_id: UUID,
                     patient_id: UUID, id_document_type: str) -> None:
        row = self.clinic(db)[pre_registration_id]
        self.clinic(db)[row.id] = replace(row, status="accepted", decided_at=self.clock,
                                          decided_by=user_id, patient_id=patient_id,
                                          id_document_type=id_document_type)

    async def reject(self, db: Any, pre_registration_id: UUID, *, user_id: UUID,
                     reason_code: str, reason_text: str | None) -> None:
        row = self.clinic(db)[pre_registration_id]
        self.clinic(db)[row.id] = replace(row, status="rejected", decided_at=self.clock,
                                          decided_by=user_id, rejection_reason_code=reason_code,
                                          rejection_reason_text=reason_text)


class FakeCipher:
    """Reversible, visibly not encryption: it proves values go through the cipher and never
    reach storage in clear (the real one is core's OpenBao Transit, #102)."""

    async def encrypt(self, plaintext: bytes) -> str:
        return "fake:" + base64.b64encode(plaintext[::-1]).decode()

    async def decrypt(self, ciphertext: str) -> bytes:
        assert ciphertext.startswith("fake:")
        return base64.b64decode(ciphertext[5:])[::-1]


@dataclass
class FakeGuards:
    """Core's public-form guards (T47): the portal origin, limits per scope and key, the bot
    check. ``limits`` sets how many requests a scope allows per key."""

    limits: dict[str, int] = field(default_factory=dict)
    counts: Counter[tuple[str, str]] = field(default_factory=Counter)
    keys_seen: list[tuple[str, str]] = field(default_factory=list)

    def origin_allowed(self, origin: str | None) -> bool:
        return origin == PORTAL_ORIGIN

    def email_key(self, email: str) -> str:
        return "k:" + hashlib.sha256(b"test-secret:" + email.encode()).hexdigest()

    async def retry_after(self, scope: str, key: str) -> int | None:
        self.keys_seen.append((scope, key))
        self.counts[(scope, key)] += 1
        allowed = self.limits.get(scope)
        return 60 if allowed is not None and self.counts[(scope, key)] > allowed else None

    async def bot_check_passes(self, payload: str) -> bool:
        return payload != "mock-altcha-failed"


def stored_plaintext(rows: dict[UUID, dict[UUID, PreRegistrationRow]]) -> str:
    """Everything the fake table holds, as text, to check nothing was stored in clear."""
    return json.dumps([r.details for clinic in rows.values() for r in clinic.values()])
