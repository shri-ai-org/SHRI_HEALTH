"""Terminology loaders (issue #85, demo step 9; A53). Each loads a public release into
``admin.concept`` and ``admin.concept_property`` under its registered ``admin.code_system``.

- ``rxnorm``: RxNorm Current Prescribable Content (NLM, monthly; no licence needed). The
  products a prescriber can pick (SCD, SBD, GPCK, BPCK) with what the drug search and the
  safety checks need, and the ingredients (IN, PIN, MIN) that allergies are recorded with.

A loader runs as ``shri_migrator`` (``MIGRATION_DATABASE_URL``), since the concept tables are
platform-wide and no service role writes them. It is re-runnable: a second load of the same
release changes nothing, and a concept a later release drops is made inactive, never deleted,
since allergies and prescriptions keep its code.

Usage:  python -m app.db.terminology rxnorm <release .zip or its rrf/ folder>
"""
