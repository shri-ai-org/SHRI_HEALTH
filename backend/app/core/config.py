"""Settings, loaded from environment variables and (optionally) OpenBao.

Priority, highest first: values passed to Settings(...), environment variables,
OpenBao KV secrets, defaults. Secrets never live in source control.
"""

import re
from functools import lru_cache
from typing import Any, Literal

import httpx
from pydantic import SecretStr, field_validator, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

Environment = Literal["development", "test", "staging", "production"]
AuthMode = Literal["dev_header", "keycloak"]

# Q31: what CI stamps into the API image (backend/Dockerfile build arguments).
_BUILD_VERSION = re.compile(r"dev|[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?")
_BUILD_COMMIT = re.compile(r"unknown|[0-9a-f]{12,40}")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    # Defaults to production, the safe side: an unset ENVIRONMENT never enables the stand-in
    # login or the API docs. Local development and tests set it explicitly.
    environment: Environment = "production"

    # "dev_header" is the Day 1 stand-in login (a test user picked by a request header).
    # It is refused outside development and test; see _dev_auth_only_in_dev below.
    auth_mode: AuthMode = "keycloak"

    # The patient portal's sign-in. "dev_header" is the development stand-in (X-Dev-Patient and
    # X-Dev-Patient-Clinic headers), refused outside development and test like auth_mode's, so
    # screens and portal reads can be built before patient sign-in exists (ADR-0013, T45).
    patient_auth_mode: AuthMode = "keycloak"

    # One database role per service (DECISIONS D23); each URL carries that role's login.
    database_url: SecretStr | None = None  # shri_app: the API (no RLS bypass)
    fhir_database_url: SecretStr | None = None  # shri_fhir_reader: read-only /fhir API
    integration_database_url: SecretStr | None = None  # shri_integration: partner worker
    reporting_database_url: SecretStr | None = None  # shri_reporting: read-only reports
    migration_database_url: SecretStr | None = None  # shri_migrator: migrations only, never the API
    # shri_public: the public pre-registration form only (D96). The role has no table privileges;
    # it can only run admin.submit_pre_registration(). Unset: public forms answer 503.
    public_database_url: SecretStr | None = None
    db_pool_size: int = 5

    # Problem Details `type` = this prefix + code (API_STANDARDS §9.1). Same placeholder as the
    # contract (API_STANDARDS §0) until COMPANY_DOMAIN is decided; then both change to
    # "tag:<COMPANY_DOMAIN>,2026:problem/".
    problem_type_base: str = "tag:company-domain.invalid,2026:problem/"

    # OpenBao (KV v2). When openbao_addr is set, secrets are read from
    # {openbao_addr}/v1/{openbao_kv_mount}/data/{openbao_secret_path} at startup.
    openbao_addr: str | None = None
    openbao_token: SecretStr | None = None
    openbao_kv_mount: str = "secret"
    openbao_secret_path: str = "shri-health/api"  # noqa: S105 (a path, not a secret)

    # OpenBao Transit, for field encryption (core/crypto.py). The token is the API's narrow one:
    # encrypt and decrypt with openbao_transit_key only, never a root token. Unset: anything that
    # needs encryption fails with a 500 (fail closed).
    openbao_transit_addr: str | None = None
    openbao_transit_token: SecretStr | None = None
    openbao_transit_mount: str = "transit"
    openbao_transit_key: str = "shri-fields"

    # Public forms (D96; core/public_form.py). portal_origin is the only `Origin` they accept,
    # exactly (scheme, host and port), e.g. "https://portal.example.org". public_form_secret keys
    # the email rate limit's hash and signs the bot-check challenges; at least 32 characters, from
    # OpenBao or the environment, never in code. Either unset: public forms answer 503.
    portal_origin: str | None = None
    public_form_secret: SecretStr | None = None
    public_form_ip_limit: int = 20  # requests per IP per window
    public_form_ip_window_seconds: int = 3600
    bot_challenge_ip_limit: int = 60  # GET /portal/bot-challenge, per IP per hour (its own budget)
    public_form_email_limit: int = 5  # requests per email address (as its keyed hash) per window
    public_form_email_window_seconds: int = 86400
    bot_check_max_number: int = 100_000  # the proof of work: about a second on a slow phone
    bot_check_ttl_seconds: int = 600  # a challenge expires after this

    # Staff sign-in (ADR-0006, SECURITY_MODEL §2.1-2.2; realm in infra/keycloak/realms/).
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

    # Q31: the build this API runs, stamped by CI as image build arguments, never typed by hand.
    # Shown to signed-in users only (GET /auth/session), never on /health. Local builds keep the
    # defaults. A malformed value stops startup instead of being shown.
    build_version: str = "dev"
    build_commit: str = "unknown"

    @field_validator("build_version")
    @classmethod
    def _valid_build_version(cls, value: str) -> str:
        if not _BUILD_VERSION.fullmatch(value) or len(value) > 64:
            raise ValueError("BUILD_VERSION must be 'dev' or a version such as 0.1.0")
        return value

    @field_validator("build_commit")
    @classmethod
    def _valid_build_commit(cls, value: str) -> str:
        if not _BUILD_COMMIT.fullmatch(value):
            raise ValueError("BUILD_COMMIT must be 'unknown' or a lowercase git commit SHA")
        return value

    @property
    def build_commit_short(self) -> str:
        """The first 12 characters of the commit, as the contract shows it (Q31)."""
        return self.build_commit[:12]

    @model_validator(mode="after")
    def _dev_auth_only_in_dev(self) -> "Settings":
        if self.auth_mode == "dev_header" and self.environment not in ("development", "test"):
            raise ValueError("auth_mode=dev_header is only allowed in development and test")
        if (self.patient_auth_mode == "dev_header"
                and self.environment not in ("development", "test")):
            raise ValueError(
                "patient_auth_mode=dev_header is only allowed in development and test")
        return self

    @property
    def show_docs(self) -> bool:
        return self.environment != "production"

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        return (init_settings, env_settings, OpenBaoSource(settings_cls, env_settings))


class OpenBaoSource(PydanticBaseSettingsSource):
    """Reads one KV v2 secret from OpenBao; its keys map to setting names (case-insensitive).

    If OpenBao is configured but cannot be read, startup fails rather than running
    with missing secrets.
    """

    def __init__(self, settings_cls: type[BaseSettings], env: PydanticBaseSettingsSource):
        super().__init__(settings_cls)
        self._env = env

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        # Unused: __call__ loads the whole secret at once.
        return None, field_name, False

    def __call__(self) -> dict[str, Any]:
        env = self._env()
        addr = env.get("openbao_addr")
        if not addr:
            return {}
        token = env.get("openbao_token")
        if not token:
            raise RuntimeError("OPENBAO_ADDR is set but OPENBAO_TOKEN is missing")
        mount = env.get("openbao_kv_mount", "secret")
        path = env.get("openbao_secret_path", "shri-health/api")
        url = f"{addr.rstrip('/')}/v1/{mount}/data/{path}"
        try:
            response = httpx.get(url, headers={"X-Vault-Token": str(token)}, timeout=5.0)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise RuntimeError(f"Could not read settings from OpenBao at {mount}/{path}") from exc
        data: dict[str, Any] = response.json()["data"]["data"]
        fields = self.settings_cls.model_fields
        return {key.lower(): value for key, value in data.items() if key.lower() in fields}


@lru_cache
def get_settings() -> Settings:
    return Settings()
