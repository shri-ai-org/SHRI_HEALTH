"""uvicorn's access log names paths only, never query strings (T53, D105, D13).

Some query strings are credentials: a download link's token (`/files/{fileId}/content?token=…`)
and the sign-in callbacks' Keycloak `code` and `state` (`/auth/callback`,
`/portal/auth/callback`). Others may carry search terms. So every logged path shows `?…` in
place of its query, as nginx logs `$uri` only (infra/nginx/nginx.conf,
infra/deploy/nginx/shri.conf.template). Core's own log lines name only the path, never the query.
"""

import logging
import re

from fastapi import FastAPI

from app.core.config import Settings

ACCESS_LOGGER = "uvicorn.access"
# Everything after the first "?": never logged.
QUERY = re.compile(r"\?.*$", re.DOTALL)


class DropSecretQueries(logging.Filter):
    """uvicorn.access records carry (client, method, path with query, HTTP version, status)."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            path = QUERY.sub("?…", args[2], count=1)
            if path != args[2]:
                record.args = (*args[:2], path, *args[3:])
        return True


def register(app: FastAPI, settings: Settings) -> None:
    logger = logging.getLogger(ACCESS_LOGGER)
    if not any(isinstance(f, DropSecretQueries) for f in logger.filters):
        logger.addFilter(DropSecretQueries())
