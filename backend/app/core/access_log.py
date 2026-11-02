"""Keeps bearer tokens in query strings out of uvicorn's access log (T53, D105).

`GET /api/v1/files/{fileId}/content?token=…` carries a download token in its query string; the
access log shows that route's path with `?…` in place of the query. nginx does the same for its
own log (infra/nginx/nginx.conf). Core's own log lines name only the path, never the query.
"""

import logging
import re

from fastapi import FastAPI

from app.core.config import Settings

ACCESS_LOGGER = "uvicorn.access"
# Routes whose query string is a credential: never logged.
SECRET_QUERY = re.compile(r"^(/api/v1/files/[^/?]+/content)\?.*$", re.DOTALL)


class DropSecretQueries(logging.Filter):
    """uvicorn.access records carry (client, method, path with query, HTTP version, status)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            path = SECRET_QUERY.sub(r"\1?…", args[2])
            if path != args[2]:
                record.args = (*args[:2], path, *args[3:])
        return True


def register(app: FastAPI, settings: Settings) -> None:
    logger = logging.getLogger(ACCESS_LOGGER)
    if not any(isinstance(f, DropSecretQueries) for f in logger.filters):
        logger.addFilter(DropSecretQueries())
