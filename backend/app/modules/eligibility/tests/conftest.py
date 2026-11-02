"""Fixtures for the eligibility tests: scheduling's live practice, users and client (a fresh
clinic per test, as shri_app, with the real core), since eligibility checks are written at
check-in (D15). Synthetic data only."""

from app.modules.scheduling.tests.conftest import client, practice, users  # noqa: F401
