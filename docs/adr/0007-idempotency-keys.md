# ADR-0007: Idempotency-Key for partner-bound and money-moving requests

Status: **Proposed** (Thulasi agreed, issue #3 T21; Anand pending) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Thulasi (middleware, integration engine), Anand (payments, claims)

## Context

VG Step 1 and CAT require an `Idempotency-Key` header on POSTs that send something to a partner (eligibility, claims, prescriptions, lab orders); your Stage 2 brief adds anything that charges money. A network timeout must never cause a second claim, prescription or card charge. The IETF draft `draft-ietf-httpapi-idempotency-key-header` reached revision -07 (2025-10-15) and has **expired without becoming an RFC** (checked 2026-10-22), but its behavior is widely used.

## Decision

1. Required (`x-idempotency: required`) on every POST that reaches a partner or moves money; accepted (`supported`) on other creating POSTs.
2. Value: a client-generated UUID, accepted bare or quoted.
3. Scope: tenant + user + method + path + key. Fingerprint: SHA-256 of the canonical body. Retention: 24 hours.
4. Behavior adopted from draft-07: missing when required → `400 idempotency-key-missing`; same key, different body → `422 idempotency-key-reused`; same key still processing → `409 idempotency-request-in-progress`; same key, same body → replay the stored status and body with `Idempotent-Replayed: true`.
5. Implemented once in middleware (agreed, T21). Stored responses can contain PHI: kept in our PostgreSQL under row-level security, bodies encrypted with `encrypt_field`, purged at expiry. `5xx` and `429` responses are not stored, so a retry runs again.

## Alternatives considered

| Option | Why not |
|---|---|
| Rely on the integration engine's message IDs only | Protects partner messages, but not the API call itself (a retry would create a second claim record) |
| Natural-key deduplication per endpoint | Different rule per endpoint; easy to get wrong |
| Wait for an RFC | The draft has expired; we need the behavior now and can align later |

## Consequences

- The generated client must create one key per user action and reuse it on retry (Minalini).
- Middleware needs a keyed response store with expiry.
- Contract lint checks that required keys and their error responses are declared.

## References

VG Step 1; CAT conventions; draft-ietf-httpapi-idempotency-key-header-07 §2.7; API_STANDARDS §10.
