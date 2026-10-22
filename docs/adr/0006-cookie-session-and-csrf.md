# ADR-0006: Session cookie with reference token, plus CSRF header

Status: **Proposed** · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Thulasi (owner, D3), Minalini (browser side of login)

## Context

D3 puts login, reference tokens and permissions in Thulasi's middleware; CAT specifies Keycloak login with code + PKCE and a session cookie that holds a reference token. Cookie authentication is sent automatically by browsers, so state-changing requests need CSRF protection. Clinic workstations are shared, so sessions must time out (TA §9).

## Decision

PROPOSED values; Thulasi decides each one:

1. Login runs server-side (`/auth/login`, `/auth/callback`); Keycloak tokens never reach the browser.
2. Cookie `__Host-shri_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`; value is a random reference token (at least 128 bits).
3. Idle timeout 15 minutes (pending clinical advisors), absolute 12 hours; `POST /auth/refresh` extends while active; `POST /auth/logout` revokes.
4. CSRF: `GET /auth/session` returns a session-bound `csrfToken`; the SPA sends `X-CSRF-Token` on every POST, PUT and PATCH; middleware also checks `Origin`. Failure → `403 csrf-check-failed`.
5. The contract declares security schemes `sessionCookie` and `csrfHeader` (SECURITY_MODEL §2.3).

## Alternatives considered

| Option | Why not |
|---|---|
| Bearer tokens (JWT) stored in the browser | Tokens readable by JavaScript are exposed to XSS; revocation is harder; D3 specifies reference tokens |
| SameSite cookie alone, no CSRF header | Defense depends on browser behavior and domain layout; a header adds an independent check at low cost |
| Double-submit cookie | Works, but a server-bound token is simpler to reason about and to revoke |

## Consequences

- The generated client must attach `X-CSRF-Token` to unsafe requests (Minalini).
- Keycloak and the app should share a registrable domain for `SameSite=Strict`; otherwise use `Lax`.
- Server-Sent Events use the same cookie; no CSRF needed for GET.

## References

D3; CAT (Thulasi section); TA §9; SECURITY_MODEL §2.
