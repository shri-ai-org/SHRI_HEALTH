"""Settings every part of the API reads: the environment, the database roles, error links and the
build stamp."""

import re
from typing import Literal

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings

Environment = Literal["development", "test", "staging", "production"]

# Q31: what CI stamps into the API image (backend/Dockerfile build arguments).
_BUILD_VERSION = re.compile(r"dev|[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?")
_BUILD_COMMIT = re.compile(r"unknown|[0-9a-f]{12,40}")


class BaseFields(BaseSettings):
    # Defaults to production, the safe side: an unset ENVIRONMENT never enables the stand-in
    # login or the API docs. Local development and tests set it explicitly.
    environment: Environment = "production"

    # One database role per service (DECISIONS D23); each URL carries that role's login.
    database_url: SecretStr | None = None  # shri_app: the API (no RLS bypass)
    fhir_database_url: SecretStr | None = None  # shri_fhir_reader: read-only /fhir API
    reporting_database_url: SecretStr | None = None  # shri_reporting: read-only reports
    migration_database_url: SecretStr | None = None  # shri_migrator: migrations only, never the API
    db_pool_size: int = 5

    # Problem Details `type` = this prefix + code (API_STANDARDS §9.1). Same placeholder as the
    # contract (API_STANDARDS §0) until COMPANY_DOMAIN is decided; then both change to
    # "tag:<COMPANY_DOMAIN>,2026:problem/".
    problem_type_base: str = "tag:company-domain.invalid,2026:problem/"

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

    @property
    def show_docs(self) -> bool:
        return self.environment != "production"
