"""Settings, loaded from environment variables and (optionally) OpenBao.

Priority, highest first: values passed to Settings(...), environment variables,
OpenBao KV secrets, defaults. Secrets never live in source control.
"""

from functools import lru_cache
from typing import Any, Literal

import httpx
from pydantic import SecretStr, model_validator
from pydantic.fields import FieldInfo
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)

Environment = Literal["development", "test", "staging", "production"]
AuthMode = Literal["dev_header", "keycloak"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore", case_sensitive=False)

    environment: Environment = "development"

    # "dev_header" is the Day 1 stand-in login (a test user picked by a request header).
    # It is refused outside development and test; see _dev_auth_only_in_dev below.
    auth_mode: AuthMode = "keycloak"

    # One database role per service (DECISIONS D23); each URL carries that role's login.
    database_url: SecretStr | None = None  # shri_app: the API (no RLS bypass)
    fhir_database_url: SecretStr | None = None  # shri_fhir_reader: read-only /fhir API
    integration_database_url: SecretStr | None = None  # shri_integration: partner worker
    reporting_database_url: SecretStr | None = None  # shri_reporting: read-only reports
    migration_database_url: SecretStr | None = None  # shri_migrator: migrations only, never the API
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

    @model_validator(mode="after")
    def _dev_auth_only_in_dev(self) -> "Settings":
        if self.auth_mode == "dev_header" and self.environment not in ("development", "test"):
            raise ValueError("auth_mode=dev_header is only allowed in development and test")
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
