"""The clinic's AI switches (inventory #114-115; FRS §3.4 kill switch): getAiSettings and
replaceAiSettings.

The clinic-wide switch is ``admin.tenant.ai_enabled``; each feature's is its
``admin.ai_feature_setting`` row, and a feature never set is off. Only this batch's features are
listed (``ambient-documentation``, ``chart-summary``; D68). The ``ETag`` is a hash of the whole
state (both switches, every feature's setting and when it changed), so ``PUT`` with a stale
``If-Match`` gets ``412`` with the current ``ETag`` instead of overwriting another admin's change.

``PUT`` sets the clinic switch and the features listed; a feature left out keeps its setting.
Turning a feature off needs a ``reason`` (``422 validation-failed`` without one, or with one
while turning it on); the same feature twice is ``422 business-rule-violation``
(``conflicting-fields``). Switching off applies from the next AI request: drafts and suggestions
already made stay readable and decidable, and nothing in the visit workflow depends on it.
"""

from __future__ import annotations

import hashlib
import json

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import PreconditionFailed, PreconditionRequired, ValidationFailed, field_error
from app.db.models.enums import AIFeature

from .repository import AIRepository, FeatureState, SettingsState
from .schemas import AiFeatureSetting, AiSettings, AiSettingsUpdate

#: The features this batch lists, in order (D68: later batches add theirs).
FEATURES = (AIFeature.AMBIENT_DOCUMENTATION, AIFeature.CHART_SUMMARY)


def as_contract(state: SettingsState) -> AiSettings:
    features = []
    for feature in FEATURES:
        found = state.features.get(feature, FeatureState(feature, False))
        features.append(AiFeatureSetting(feature=feature.value, enabled=found.enabled,
                                         reason=None if found.enabled else found.reason,
                                         updated_at=found.updated_at))
    return AiSettings(clinic_enabled=state.clinic_enabled, features=features)


def etag(state: SettingsState) -> str:
    """A strong ETag over everything the settings show and when each part last changed."""
    stamp = {"clinic": [state.clinic_enabled, str(state.clinic_updated_at)],
             "features": {f.value: [s.enabled, s.reason, str(s.updated_at)]
                          for f, s in sorted(state.features.items())}}
    digest = hashlib.sha256(json.dumps(stamp, sort_keys=True).encode()).hexdigest()
    return f'"{digest[:20]}"'


async def get(db: AsyncSession, repo: AIRepository) -> tuple[AiSettings, str]:
    state = await repo.settings(db)
    return as_contract(state), etag(state)


def _check(body: AiSettingsUpdate) -> None:
    errors, seen, repeated = [], set(), []
    for i, f in enumerate(body.features or []):
        if not f.enabled and f.reason is None:
            errors.append(field_error("body", f"/features/{i}/reason", "required"))
        if f.enabled and f.reason is not None:
            errors.append(field_error("body", f"/features/{i}/reason", "not-allowed-value"))
        if f.feature in seen:
            repeated.append(field_error("body", f"/features/{i}/feature", "conflicting-fields"))
        seen.add(f.feature)
    if errors:
        raise ValidationFailed(errors=errors)
    if repeated:
        raise ValidationFailed(code="business-rule-violation", errors=repeated)


async def replace(db: AsyncSession, repo: AIRepository, body: AiSettingsUpdate,
                  if_match: str | None) -> tuple[AiSettings, str]:
    if if_match is None:
        raise PreconditionRequired()
    _check(body)
    current = await repo.settings(db, lock=True)   # the clinic's row: one PUT at a time
    if if_match.strip() != etag(current):
        raise PreconditionFailed(headers={"ETag": etag(current)})
    if body.clinic_enabled != current.clinic_enabled:
        await repo.set_clinic(db, body.clinic_enabled)
    for f in body.features or []:
        feature = AIFeature(f.feature)
        now = current.features.get(feature)
        if now is None or now.enabled != f.enabled or (not f.enabled and now.reason != f.reason):
            await repo.set_feature(db, feature, f.enabled, f.reason)
    await db.commit()
    saved = await repo.settings(db)
    return as_contract(saved), etag(saved)
