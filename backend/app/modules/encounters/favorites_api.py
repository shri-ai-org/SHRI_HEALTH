"""The current user's favorites (inventory #84-85; encounters.yaml getMyFavorites,
replaceMyFavorites). The permission (``require``) is the first dependency. Personal settings with
no patient data: GET is audited ``none`` and PUT ``admin`` (D73), by core from the contract."""

from typing import Annotated

from fastapi import APIRouter, Depends, Header, Response

from app.core.deps import CurrentUser, require

from . import favorites_schemas as fs
from . import favorites_service as fservice
from .api import DB
from .favorites_repository import SqlFavoritesRepository

router: APIRouter = APIRouter(tags=["encounters"])


def favorites_repository() -> SqlFavoritesRepository:
    return SqlFavoritesRepository()


FRepo = Annotated[SqlFavoritesRepository, Depends(favorites_repository)]


@router.get("/me/favorites", operation_id="getMyFavorites", response_model=fs.Favorites,
            response_model_exclude_none=True)
async def get_my_favorites(
    user: Annotated[CurrentUser, Depends(require("favorites:read"))],
    response: Response, db: DB, repo: FRepo,
) -> fs.Favorites:
    found, tag = await fservice.get(db, repo, user)
    response.headers["ETag"] = tag
    return found


@router.put("/me/favorites", operation_id="replaceMyFavorites", response_model=fs.Favorites,
            response_model_exclude_none=True)
async def replace_my_favorites(
    user: Annotated[CurrentUser, Depends(require("favorites:update"))],
    body: fs.FavoritesUpdate, response: Response, db: DB, repo: FRepo,
    if_match: Annotated[str | None, Header(alias="If-Match", max_length=128)] = None,
) -> fs.Favorites:
    saved, tag = await fservice.replace(db, repo, user, body, if_match)
    response.headers["ETag"] = tag
    return saved
