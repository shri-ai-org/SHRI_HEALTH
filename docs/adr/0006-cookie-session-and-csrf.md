# ADR-0006: Session cookie with reference token, plus CSRF header

Status: **Accepted** (2026-10-22: Thulasi, issue #3 T7–T9 with additions; Minalini, issue #5 M4, M15) · 2026-10-22 · Author: Vimal · **Needs sign-off from:** Thulasi (owner, D3), Minalini (browser side of login)

## Context

D3 puts login, reference tokens and permissions in Thulasi's middleware; CAT specifies Keycloak login with code + PKCE and a session cookie that holds a reference token. Cookie authentication is sent automatically by browsers, so state-changing requests need CSRF protection. Clinic workstations are shared, so sessions must time out (TA §9).

## Decision

As agreed by Thulasi (T7–T9) and Minalini (M4, M15):

1. Login runs server-side (`/auth/login`, `/auth/callback`); Keycloak tokens never reach the browser. PKCE verifier, `state` and `nonce` are stored server-side, keyed by a short-lived `__Host-shri_login` cookie (`SameSite=Lax`, 10 minutes). Keycloak is served on the same origin at `/kc/`.
2. Cookie `__Host-shri_session`: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`. Its value is a 256-bit reference token (`secrets.token_urlsafe(32)`); the server stores only its SHA-256 hash. A new session ID is issued at every login.
3. Idle timeout 15 minutes (pending clinical advisors), absolute 12 hours. Only user-initiated requests reset the idle timer; the event stream, keep-alives and `/operations` polling do not. `POST /auth/refresh` extends; `POST /auth/logout` revokes. The screen warns at 13 minutes with "Stay signed in" (proposed by Vimal, M15; Thulasi to confirm).
4. CSRF: `GET /auth/session` returns a session-bound `csrfToken` that rotates at login; the SPA sends `X-CSRF-Token` on every unsafe method, including `/auth/refresh` and `/auth/logout`; comparison is constant-time; `Origin` is required and checked against an allowlist from settings. Failure → `403 csrf-check-failed`.
5. The contract declares security schemes `sessionCookie` and `csrfHeader` (SECURITY_MODEL §2.3). Minalini's single fetch wrapper adds the header (M4).

## Alternatives considered

| Option | Why not |
|---|---|
| Bearer tokens (JWT) stored in the browser | Tokens readable by JavaScript are exposed to XSS; revocation is harder; D3 specifies reference tokens |
| SameSite cookie alone, no CSRF header | Defense depends on browser behavior and domain layout; a header adds an independent check at low cost |
| Double-submit cookie | Works, but a server-bound token is simpler to reason about and to revoke |

## Consequences

- The generated client must attach `X-CSRF-Token` to unsafe requests (Minalini).
- Keycloak on the same origin (`/kc/`) makes `SameSite=Strict` work for the session cookie; only the short-lived login-state cookie is `Lax`.
- Server-Sent Events use the same cookie; no CSRF needed for GET.

## References

D3; CAT (Thulasi section); TA §9; SECURITY_MODEL §2.
