"""The current user's favorites (inventory #84-85; FRS FR-ENC-04; encounters.yaml Favorite,
Favorites, FavoritesUpdate). Personal settings, no patient data."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field

from .schemas import Closed, Coding, Out, _text

FavoriteKind = Literal["note-template", "diagnosis", "order", "order-set", "prescription", "phrase"]


class Favorite(Closed):
    kind: FavoriteKind
    target_id: UUID | None = None
    diagnosis: Coding | None = None
    label: Annotated[str, _text(200)] | None = None  # read-only on GET; ignored on PUT


class FavoriteOut(Out):
    kind: FavoriteKind
    target_id: UUID | None = None
    diagnosis: Coding | None = None
    label: str | None = None


class Favorites(Out):
    favorites: list[FavoriteOut]
    updated_at: datetime | None = None


class FavoritesUpdate(Closed):
    favorites: Annotated[list[Favorite], Field(max_length=300)]
