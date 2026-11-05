"""getMyFavorites and replaceMyFavorites (inventory #84-85; FRS FR-ENC-04): the signed-in user's
own list, never anyone else's (there is no user in the path). The ETag is a digest of the list,
so a second tab's PUT gets 412 instead of overwriting (D73: GET audited none, PUT admin)."""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import CurrentUser
from app.core.errors import PreconditionFailed, PreconditionRequired, field_error
from app.db.models import systems

from . import favorites_schemas as fs
from .favorites_repository import FavoriteRow, NewFavorite, SqlFavoritesRepository
from .schemas import Coding
from .service import business_rule


def etag(rows: list[FavoriteRow]) -> str:
    """A strong ETag over every favorite and when it last changed."""
    stamp = [[str(r.id), r.kind, r.sequence, str(r.target_id), r.diagnosis_code,
              str(r.updated_at)] for r in rows]
    return f'"{hashlib.sha256(json.dumps(stamp).encode()).hexdigest()[:20]}"'


def _out(rows: list[FavoriteRow]) -> fs.Favorites:
    favorites = [fs.FavoriteOut(
        kind=r.kind,
        target_id=r.target_id,
        diagnosis=Coding(system=r.diagnosis_system, code=r.diagnosis_code,
                         display=r.diagnosis_display) if r.diagnosis_code else None,
        label=r.label) for r in rows]
    latest = max((r.updated_at for r in rows), default=None)
    return fs.Favorites(favorites=favorites, updated_at=latest)


async def get(db: AsyncSession, repo: SqlFavoritesRepository, user: CurrentUser
              ) -> tuple[fs.Favorites, str]:
    rows = await repo.rows(db, user.id)
    return _out(rows), etag(rows)


def _strong(header: str | None) -> str:
    """The If-Match value as sent (a strong tag); 428 without one."""
    if header is None:
        raise PreconditionRequired()
    value = header.strip()
    if not (value.startswith('"') and value.endswith('"')):
        raise PreconditionFailed()  # a weak or malformed tag never matches a strong one
    return value


async def replace(db: AsyncSession, repo: SqlFavoritesRepository, user: CurrentUser,
                  body: fs.FavoritesUpdate, if_match: str | None) -> tuple[fs.Favorites, str]:
    wanted = _strong(if_match)
    errors = []
    by_kind: dict[str, list[UUID]] = defaultdict(list)
    codes: list[str] = []
    for i, f in enumerate(body.favorites):
        where = f"/favorites/{i}"
        if f.kind == "diagnosis":
            if f.diagnosis is None:
                errors.append(field_error("body", f"{where}/diagnosis", "required"))
            elif f.diagnosis.system != systems.ICD10CM:
                errors.append(field_error("body", f"{where}/diagnosis/system",
                                          "not-allowed-value"))
            else:
                codes.append(f.diagnosis.code)
            if f.target_id is not None:
                errors.append(field_error("body", f"{where}/targetId", "conflicting-fields"))
        else:
            if f.target_id is None:
                errors.append(field_error("body", f"{where}/targetId", "required"))
            else:
                by_kind[f.kind].append(f.target_id)
            if f.diagnosis is not None:
                errors.append(field_error("body", f"{where}/diagnosis", "conflicting-fields"))
    usable = {kind: await repo.usable_targets(db, kind, ids, user.id)
              for kind, ids in by_kind.items()}
    concepts = await repo.diagnoses(db, codes)
    for i, f in enumerate(body.favorites):
        where = f"/favorites/{i}"
        if f.kind != "diagnosis" and f.target_id is not None \
                and f.target_id not in usable.get(f.kind, set()):
            errors.append(field_error("body", f"{where}/targetId", "invalid-reference"))
        if f.kind == "diagnosis" and f.diagnosis is not None \
                and f.diagnosis.system == systems.ICD10CM:
            found = concepts.get(f.diagnosis.code)
            if found is None:
                errors.append(field_error("body", f"{where}/diagnosis/code",
                                          "invalid-reference"))
            elif not found[1]:  # a header code can't be put on a visit, so not a favorite either
                errors.append(field_error("body", f"{where}/diagnosis/code",
                                          "not-allowed-value"))
    if errors:
        raise business_rule(errors)
    await repo.lock(db, user.id)
    current = await repo.rows(db, user.id)
    if etag(current) != wanted:
        raise PreconditionFailed(headers={"ETag": etag(current)})
    sequence: dict[str, int] = defaultdict(int)
    items = []
    for f in body.favorites:  # the order within each kind is the order sent
        sequence[f.kind] += 1
        display = concepts[f.diagnosis.code][0] if f.kind == "diagnosis" and f.diagnosis else None
        items.append(NewFavorite(kind=f.kind, sequence=sequence[f.kind], target_id=f.target_id,
                                 diagnosis_code=f.diagnosis.code if f.diagnosis else None,
                                 diagnosis_display=display))
    await repo.replace(db, user.id, items)
    await db.commit()
    rows = await repo.rows(db, user.id)
    return _out(rows), etag(rows)
