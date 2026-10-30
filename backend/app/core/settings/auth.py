"""Staff sign-in (ADR-0006, SECURITY_MODEL §2.1-2.2; the realm in infra/keycloak/realms/)."""

from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings

AuthMode = Literal["dev_header", "keycloak"]


class AuthFields(BaseSettings):
    # "dev_header" is the Day 1 stand-in login (a test user picked by a request header).
    # It is refused outside development and test (Settings._dev_auth_only_in_dev).
    auth_mode: AuthMode = "keycloak"

    # keycloak_public_url: what the browser and the token's issuer see ("https://localhost:8443/kc").
    # keycloak_internal_url: how the API reaches Keycloak server to server ("http://keycloak:8080/kc").
    # session_secret keys the CSRF token (an HMAC of the session token); at least 32 characters,
    # from OpenBao or the environment. allowed_origins: the only Origins for POST, PUT and PATCH.
    keycloak_public_url: str | None = None
    keycloak_internal_url: str | None = None
    keycloak_realm: str = "shri-staff"
    keycloak_client_id: str = "shri-web"
    keycloak_client_secret: SecretStr | None = None
    keycloak_redirect_uri: str | None = None  # https://<host>/api/v1/auth/callback
    session_secret: SecretStr | None = None
    allowed_origins: list[str] = []
    session_idle_minutes: int = 15  # Q20, pending the clinical advisors
    session_absolute_hours: int = 12
    token_refresh_minutes: int = 5  # D94's backstop: a disabled user's refresh fails within this
    after_login_path: str = "/"
