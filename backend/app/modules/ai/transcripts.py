"""Visit transcripts (AI-01): reading one, the text the model gets, and the source links from a
drafted section back to the segments it came from.

**Where a transcript lives.** ``admin.transcript`` (Anand's schema) holds the metadata and
points at a file (``binary_object_id``) through the file service, sealed with its own data key
like every stored file (D105). The file is the original transcript, never edited, as JSON::

    {"segments": [{"sequence": 1, "startMs": 0, "endMs": 4200, "speaker": "clinician",
                   "text": "...", "confidence": "high"}, ...]}

the contract's ``TranscriptSegment`` list. Nothing here writes one: speech-to-text
(``createTranscription``) waits on the speech service and on a server-generated file purpose for
transcripts (see the module's report). Reading needs only the file service's store and crypto.

**Source links** are a fixed rule, never the model: a segment supports a drafted section when
they share content words (``link_segments``). A section no segment supports is ``no-source``,
which the clinician sees on the suggestion.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol
from uuid import UUID

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import InternalError
from app.modules.files.crypto import FileCrypto
from app.modules.files.storage import CLEAN_BUCKET, FileStore

from .schemas import Segment, TranscriptSegment

#: The speakers as the model sees them, one line per segment ("Clinician: ...").
SPEAKER_LABELS = {"clinician": "Clinician", "patient": "Patient", "other": "Other",
                  "unknown": "Speaker"}
#: At most this many segments are linked from one section, the best supported first.
MAX_LINKS = 10
EXCERPT_CHARS = 1000


@dataclass(frozen=True)
class TranscriptHead:
    """What the rules need before the transcript's text is read (no patient text)."""
    id: UUID
    audio_recording_id: UUID
    encounter_id: UUID
    patient_id: UUID
    language: str
    model_name: str
    model_version: str | None
    pipeline_version: str
    created_at: datetime
    storage_key: str
    bucket: str
    state: str
    wrapped_data_key: str | None


class Transcripts(Protocol):
    async def head(self, db: AsyncSession, transcription_id: UUID) -> TranscriptHead | None:
        """The clinic's transcript (row-level security), or None."""
        ...

    async def segments(self, db: AsyncSession, head: TranscriptHead) -> tuple[Segment, ...]:
        """The transcript's segments, decrypted from its file."""
        ...


_HEAD = text("""
SELECT t.id, t.audio_recording_id, t.encounter_id, a.patient_id, t.language, t.asr_model,
       t.created_at, r.model_version, r.pipeline_version,
       b.storage_key, b.bucket, b.state, b.wrapped_data_key
FROM admin.transcript t
JOIN admin.audio_recording a ON a.id = t.audio_recording_id
JOIN admin.binary_object b ON b.id = t.binary_object_id
LEFT JOIN admin.ai_request r ON r.id = t.ai_request_id
WHERE t.id = :id AND t.purged_at IS NULL
""")

_SEGMENTS = TypeAdapter(list[TranscriptSegment])


def parse_segments(data: bytes) -> tuple[Segment, ...]:
    """The transcript file's segments, in order. A file that isn't the format is a server
    error (500), never a partial transcript."""
    try:
        document: Any = json.loads(data)
        rows = _SEGMENTS.validate_python(document["segments"])
    except (ValueError, KeyError, TypeError, ValidationError):
        raise InternalError("A stored transcript could not be read") from None
    return tuple(Segment(sequence=s.sequence, start_ms=s.start_ms, end_ms=s.end_ms,
                         speaker=s.speaker, text=s.text, confidence=s.confidence)
                 for s in sorted(rows, key=lambda s: s.sequence))


def transcript_file(segments: tuple[Segment, ...]) -> bytes:
    """The file form of a transcript (the format above)."""
    return json.dumps({"segments": [
        {"sequence": s.sequence, "startMs": s.start_ms, "endMs": s.end_ms, "speaker": s.speaker,
         "text": s.text, **({"confidence": s.confidence} if s.confidence else {})}
        for s in segments]}).encode()


class FileTranscripts:
    """Transcripts through the file service's store and crypto (Anand's)."""

    def __init__(self, store: FileStore, crypto: FileCrypto) -> None:
        self._store, self._crypto = store, crypto

    async def head(self, db: AsyncSession, transcription_id: UUID) -> TranscriptHead | None:
        r = (await db.execute(_HEAD, {"id": transcription_id})).mappings().first()
        if r is None:
            return None
        return TranscriptHead(
            id=r["id"], audio_recording_id=r["audio_recording_id"],
            encounter_id=r["encounter_id"], patient_id=r["patient_id"], language=r["language"],
            model_name=r["asr_model"] or "unrecorded", model_version=r["model_version"],
            pipeline_version=r["pipeline_version"] or "unrecorded", created_at=r["created_at"],
            storage_key=r["storage_key"], bucket=r["bucket"], state=r["state"],
            wrapped_data_key=r["wrapped_data_key"])

    async def segments(self, db: AsyncSession, head: TranscriptHead) -> tuple[Segment, ...]:
        if head.state != "clean" or head.bucket != CLEAN_BUCKET:
            raise InternalError("A transcript file is not stored")
        sealed = await self._store.get(head.storage_key, bucket=head.bucket)
        return parse_segments(await self._crypto.open(sealed, head.wrapped_data_key,
                                                      context=head.storage_key))


def transcript_text(segments: tuple[Segment, ...]) -> str:
    """What the model reads: one "Speaker: words" line per segment (as ai/eval does)."""
    return "\n".join(f"{SPEAKER_LABELS.get(s.speaker, 'Speaker')}: {s.text}" for s in segments)


# ----------------------------------------------------------------------------- source links
_WORD = re.compile(r"[a-z0-9]+(?:'[a-z]+)?")
_STOP = frozenset("""
a an and are as at be been but by for from had has have he her his i if in into is it its me
my no not of on or our she so than that the their them then there they this to too was we were
what when which who will with you your about after also any can did do does just more most
over some such very would could should yes okay ok well let lets let's good today
""".split())


def _words(value: str) -> set[str]:
    return {w for w in _WORD.findall(value.lower()) if w not in _STOP and len(w) > 1}


def link_segments(section_text: str, segments: tuple[Segment, ...]
                  ) -> list[tuple[int, str]]:
    """The segments that support a drafted section, as (sequence, excerpt), best first.

    A fixed lexical rule, the same every time: a segment is linked when it shares at least two
    content words with the section (one, for a section of fewer than four content words)."""
    wanted = _words(section_text)
    if not wanted:
        return []
    needed = 1 if len(wanted) < 4 else 2
    scored = []
    for s in segments:
        shared = len(wanted & _words(s.text))
        if shared >= needed:
            scored.append((-shared, s.sequence, s.text[:EXCERPT_CHARS]))
    return [(sequence, excerpt) for _, sequence, excerpt in sorted(scored)[:MAX_LINKS]]
