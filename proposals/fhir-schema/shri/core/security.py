"""Authentication: Keycloak-issued JWTs (OIDC). The token carries the tenant and the Shri user
id as custom claims; roles come from realm_access. Authorization of individual actions is
checked against the role -> permission tables, and tenant isolation is enforced again by
PostgreSQL row-level security."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from functools import lru_cache

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from shri.core.config import settings

bearer = HTTPBearer(auto_error=False)


@dataclass(frozen=True)
class AuthContext:
    tenant_id: uuid.UUID
    user_id: uuid.UUID
    roles: frozenset[str] = field(default_factory=frozenset)
    correlation_id: str | None = None


@lru_cache(maxsize=1)
def _jwks() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(settings.oidc_jwks_url, cache_keys=True)


def decode_token(token: str) -> dict:
    key = _jwks().get_signing_key_from_jwt(token).key
    return jwt.decode(token, key, algorithms=["RS256", "ES256"], audience=settings.oidc_audience,
                      issuer=settings.oidc_issuer, options={"require": ["exp", "iat", "sub"]})


async def auth_context(request: Request,
                       creds: HTTPAuthorizationCredentials | None = Depends(bearer)
                       ) -> AuthContext:
    if creds is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token",
                            headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = decode_token(creds.credentials)
        tenant = uuid.UUID(claims[settings.tenant_claim])
        user = uuid.UUID(claims[settings.user_claim])
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token",
                            headers={"WWW-Authenticate": "Bearer"}) from exc
    roles = frozenset(claims.get("realm_access", {}).get("roles", []))
    return AuthContext(tenant, user, roles, request.headers.get("X-Correlation-ID"))
