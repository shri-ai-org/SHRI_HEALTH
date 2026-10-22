# ADR-0003: Errors as Problem Details (RFC 9457) with a stable code catalogue

Status: **Accepted** (2026-10-22: Vimal; Thulasi, issue #3 T19) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Vimal, Thulasi (owner of `backend/app/core/errors.py`)

## Context

VG Step 1 requires every error to use "the shared Problem JSON object"; TW §7 requires endpoints to raise the classes in `core/errors.py` and never return ad-hoc error dicts. RFC 9457 (July 2023) is the current standard for Problem Details and obsoletes RFC 7807. Error messages are a common PHI leak (e.g. "Patient Jane Doe not found"), and screens need a stable value to switch on.

## Decision

1. Every 4xx and 5xx response is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, plus our extensions `code`, `requestId` and, for validation, `errors[]` (`in`, `pointer` or `name`, field `code`) (API_STANDARDS §9).
2. `code` comes from a versioned catalogue (API_STANDARDS §9.3). Codes are never renamed or reused; new codes may be added.
3. `detail` and field errors never contain PHI or echo submitted values. `instance` is the path only, never the query.
4. `type` is an absolute URI per code. PROPOSED: tag URIs `tag:<COMPANY_DOMAIN>,2026:problem/<code>` (no hosted page needed). The domain is one constant, `COMPANY_DOMAIN`, defined in API_STANDARDS §0 and still open; until it is decided, `core/errors.py` takes the `type` base from a settings value (T19).
5. `core/errors.py` (Thulasi) produces this shape, including replacing FastAPI's default 422 validation body.

## Alternatives considered

| Option | Why not |
|---|---|
| FastAPI default errors (`{"detail": …}`) | Different shapes for validation and other errors; no stable code; may echo input |
| Custom envelope (`{"error": {…}}`) | Reinvents a standard that tooling and Schemathesis already understand |
| Switching on `title` or HTTP status only | Titles are for humans; one status (409, 422) covers many situations |

## Consequences

- Clients have one error type to handle, keyed by `code`.
- Adding an error situation means adding a catalogue code via contract PR.
- Thulasi's exception handlers must map every error class and FastAPI's validation errors to this shape.
- Contract tests validate every error body (CONTRACT_GOVERNANCE §6 layer 4).

## References

RFC 9457; VG Step 1; TW §7; API_STANDARDS §9.
