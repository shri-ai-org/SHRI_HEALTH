"""Settings from environment variables (prefix SHRI_). Secrets come from OpenBao-injected env."""
from __future__ import annotations

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHRI_", env_file=".env", extra="ignore")

    environment: str = "development"
    database_url: str = "postgresql+psycopg://shri_app@localhost:5432/shri_health"
    db_pool_size: int = 10
    # Keycloak OIDC
    oidc_issuer: str = "https://keycloak.local/realms/shri"
    oidc_audience: str = "shri-api"
    oidc_jwks_url: str = "https://keycloak.local/realms/shri/protocol/openid-connect/certs"
    tenant_claim: str = "shri_tenant_id"
    user_claim: str = "shri_user_id"
    fhir_base_url: str = "https://api.shri.health/fhir/r4"
    fhir_max_page_size: int = 200


settings = Settings()
