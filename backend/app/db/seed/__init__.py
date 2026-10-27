"""Synthetic setup data for development and the demo (issue #13; IMPL_BATCH1_PLAN §8).

Synthetic only: no real practice, provider or patient. Every row has a fixed ID and is inserted
only if it is missing, so a second run changes nothing (no version or ETag moves).

Layers, each building on the one before, through the same insert-if-missing builders:
- ``starter`` (this package today): the practices the dev users of core's ``X-Dev-User`` sign in
  to (``CLINIC_A``, ``CLINIC_B``), facilities, providers, schedules, visit types, a payer, note
  templates, the MRN counter (as onboarding creates it) and an ``app_user`` row per dev user;
- ``demo``: the starter layer plus a pharmacy, more payers, the consent requirements, and
  synthetic patients with coverage, a preferred pharmacy and appointments on the demo day
  (Fri 20 Nov). The demo users linked to Keycloak come with Thulasi's demo realm;
- reset (later): drop and recreate the demo database, migrate, then seed ``demo``. The audit
  protections are never disabled or bypassed.

It runs as ``shri_migrator`` (``MIGRATION_DATABASE_URL``), because creating a practice is a
platform action no service role may take. It sets ``app.current_tenant_id`` for each practice,
so forced row-level security checks every row it writes, and every trigger fires. It refuses a
login that bypasses row-level security. This is for development and test databases only:
production onboarding must not copy it, since D23 keeps ``shri_migrator`` for migrations; it
needs its own design.

Usage:  python -m app.db.seed {starter|demo}    (ENVIRONMENT must be development or test)
"""
