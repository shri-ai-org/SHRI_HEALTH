# Security model for the API

Status: **PROPOSED** · Version 0.1 · 2026-10-22 · Author: Vimal (drafted with Claude Code)
**Needs sign-off from:** Thulasi (owner of security and middleware, D3). **Signed off by Thulasi on issue #3 (2026-10-22), with the additions applied below.** Role matrix also needs review by the clinical advisors (FRS §10 lists them as decision owners for clinical workflow).

This document says how every endpoint relies on Thulasi's middleware, and what the contract must declare so the middleware can enforce it. It does not design the middleware. Every item Thulasi decides is marked **Pending Thulasi** with a PROPOSED answer, and collected in [notes/NOTE_FOR_THULASI.md](notes/NOTE_FOR_THULASI.md).

Fixed by source documents:

- Security lives in the middleware: login with reference tokens, permissions, row-level security, audit, encryption, file-encryption keys, rate limits. Endpoints never handle tokens, passwords or encryption (D3).
- Every endpoint uses `Depends(require("<permission>"))` and `Depends(tenant_db)` (TW §7, CLAUDE.local).
- Restricted charts need a stated reason to open (break-the-glass) and are audited (FRS FR-PAT-01, TA §9).
- Administrative access does not automatically grant clinical record access; Shri platform administrators get no clinical access by default (TA §3, §6).
- No PHI in URLs (VD-G2); synthetic data only outside production (D12).

---

## 1. Endpoint security classes

Every operation's `x-permission` puts it in exactly one class.

| Class | `x-permission` value | Who can call | Examples |
|---|---|---|---|
| Public | `public` | Anyone; no session | `GET /auth/login`, `GET /auth/callback`, `GET /health`, `GET /ready`; the portal's `GET /portal/auth/login`, `GET /portal/auth/callback` and `POST /portal/enrollments` (ADR-0013 §3, §5; lint allowlist `shri-public-allowlist`) |
| Authenticated | `authenticated` | Any logged-in user, acting on their own data | `GET /me`, `GET /auth/session`, `POST /auth/logout`, `GET /events/stream`, `GET /operations/{operationId}`; with the portal cookie, `GET /portal/auth/session`, `POST /portal/auth/refresh`, `POST /portal/auth/logout` |
| Permission | `<resource>:<action>` | Users whose roles include that permission | Almost every endpoint |
| Partner | `partner-signed` | A partner whose request signature verifies | `POST /hooks/clearinghouse` |

The contract has no endpoint without `x-permission` (lint rule, CONTRACT_GOVERNANCE §5).

## 2. Session and CSRF

### 2.1 Login and session (D3, CAT Thulasi section)

1. `GET /api/v1/auth/login` → `302` to Keycloak (authorization code with PKCE `S256`, `state` and `nonce`). The PKCE verifier, `state` and `nonce` are kept **server-side**, keyed by a short-lived login cookie `__Host-shri_login` (`SameSite=Lax`, 10 minutes), because the return from Keycloak is a top-level navigation.
2. `GET /api/v1/auth/callback` → middleware checks `state` and `nonce`, exchanges the code, stores Keycloak's tokens **server-side**, creates a **new session ID at every login** (prevents session fixation), sets the session cookie, `302` back to the SPA.
3. The browser only ever holds the session cookie. Its value is a **reference token** of 256 bits (`secrets.token_urlsafe(32)`). The server stores only its **SHA-256 hash**, so a database leak does not reveal live sessions.
4. Keycloak is served on the **same origin**, under `/kc/`, so `SameSite=Strict` works for the session cookie.

**Agreed by Thulasi (issue #3, T7, T9), 2026-10-22:**

| Attribute | Value | Reason |
|---|---|---|
| Name | `__Host-shri_session` | The `__Host-` prefix forces `Secure`, `Path=/` and no `Domain`, so subdomains cannot set or read it |
| `HttpOnly` | yes | JavaScript cannot read it (limits XSS impact) |
| `Secure` | yes | HTTPS only |
| `SameSite` | `Strict` | Not sent on cross-site requests; possible because Keycloak is same-origin at `/kc/` |
| Login-state cookie | `__Host-shri_login`, `SameSite=Lax`, 10 minutes | Holds only a key to the server-side PKCE state |
| Idle timeout | 15 minutes (**pending clinical advisors**) | Automatic logoff on shared clinic workstations (TA §9) |
| Absolute lifetime | 12 hours | One clinic day |
| What resets the idle timer | **Only user-initiated requests.** The SSE stream, its keep-alives, `/operations` polling and `GET /auth/session` never reset it; otherwise no one would ever time out, and a tab re-reading the session before its idle warning would keep it alive | T9; Thulasi on #29 |
| Idle warning | Shown at **13 minutes**, two minutes before logout, timed from `idleExpiresAt` returned by `GET /auth/session` (not a browser-only timer, so activity in another tab counts). A "Stay signed in" button calls `POST /auth/refresh` and counts as user activity | M15; confirmed by Thulasi (issue #3) |
| Absolute-limit notice | Shown before the 12-hour absolute limit (`expiresAt` from `GET /auth/session`), which **cannot be extended**, so people can save their work | Thulasi (issue #3) |
| Refresh | `POST /auth/refresh` extends the idle timer (a user action) | CAT |
| Logout | `POST /auth/logout` deletes the server session **and ends the user's Keycloak login session** (Keycloak's logout endpoint over the back channel, with the stored refresh token); returns `204` | CAT; Thulasi on #29 |
| Idle and absolute expiry | The server ends the Keycloak login session too, before deleting ours (on the next request or in the clean-up job). While our session is active, each user-initiated request also refreshes the stored Keycloak tokens server-side when the last refresh is more than 5 minutes old (background calls never do), so Keycloak's login stays alive with ours. A refused refresh (user disabled or Keycloak session revoked) ends our session immediately and is audited. Backstop: the realm's SSO Session Idle is our idle timeout plus 5 minutes (20 minutes) and SSO Session Max is 12 hours plus 5 minutes, so our limits always apply first and Keycloak ends its own login if our calls fail | Thulasi on #29 and #35 |
| Login | `GET /auth/login` always sends `prompt=login`, so every new login asks for credentials even if a Keycloak cookie survives; there is no single sign-on across apps to keep. The browser starts login only when the user clicks "Sign in", never on its own after expiry or sign-out | Thulasi on #29; Minalini's PR #29 |

### 2.2 CSRF (agreed by Thulasi, issue #3, T8)

A cookie-authenticated API needs CSRF protection on state-changing requests.

- `GET /api/v1/auth/session` returns `{ user, organization, csrfToken, idleExpiresAt, expiresAt }`. The token is bound to the session and **rotates at every login**.
- The SPA sends `X-CSRF-Token: <token>` on **every unsafe method** (POST, PUT, PATCH), including `/auth/refresh` and `/auth/logout`. Missing or wrong → `403 csrf-check-failed`. The comparison is **constant-time**.
- The `Origin` header is **required** on unsafe methods and checked against an allowlist from settings; missing or not allowed → `403 csrf-check-failed`.
- `SameSite=Strict` plus the header gives two independent defenses.

### 2.3 OpenAPI security schemes (written in Stage 3)

```yaml
components:
  securitySchemes:
    sessionCookie: { type: apiKey, in: cookie, name: __Host-shri_session }
    csrfHeader:    { type: apiKey, in: header, name: X-CSRF-Token }
    delegatedToken: { type: http, scheme: bearer }   # AI gateway only, see §2.4
    portalSessionCookie: { type: apiKey, in: cookie, name: __Host-shri_portal }   # /portal/* only (ADR-0013 §5, D89)
security:
  - sessionCookie: []          # default for GET
# POST/PUT/PATCH operations: [{ sessionCookie: [], csrfHeader: [] }]
# public operations: security: []
# portal operations: [{ portalSessionCookie: [] }], writes [{ portalSessionCookie: [], csrfHeader: [] }]
```

The two cookies never mix: an operation names one or the other, never both (lint rule `shri-security`), staff routes refuse the portal session and portal routes the staff one (core, ADR-0013 §5).

### 2.4 Service-to-service calls

| Caller | How it authenticates | Rule |
|---|---|---|
| AI gateway → API (AI-02 reads chart data through the clinical APIs, VG Step 7) | **Agreed (Thulasi, T10):** the API **mints a delegated token when the user starts the AI task** and passes it to the gateway with the job. Lifetime: at most 5 minutes or the length of the task. Bound to user, clinic, patient and task; **read permissions only**; every use audited as `ai`. The gateway can read only what that user could read, for that patient. | Never a broad service account: a compromised gateway must not reach every chart |
| Integration engine workers | Run inside the backend codebase; use `tenant_db` with the tenant taken from the job, not an HTTP token | TA §7.1 |
| Partners → `/hooks/*` | Partner signature verified by middleware | CAT |
| Outside FHIR clients → `/fhir` | Client-credentials machine token checked by Thulasi's core; the clinic comes from the token's client registration. Anand's API is read-only, runs as the `shri_fhir_reader` role (clinical read only, plus insert-only on `audit_event`; no access to `break_glass_access`; D23), never serves a restricted chart (404, also left out of search results, Bundle totals, `_include`/`_revinclude`, version history and version reads; denied requests are audited; D22), offers `POST _search` so search terms need not go in the URL, and strips query strings from every log. Not in our contract | D22, D23, ADR-0011, VD-SCOPE |

## 3. What middleware does on each request

**Agreed by Thulasi (issue #3, T11, T20, T23).** The check order is **401 → CSRF → 403 permission → 404 → 403 break-glass**:

1. Take `X-Request-ID` from the client **only if it is a valid UUID**; otherwise generate one (stops log injection). Propagate `traceparent`.
2. Rate limit: coarse limits in Nginx, per-user limits in the app (stricter on `/auth/*` and `POST …/search`).
3. Resolve session cookie → user, roles (permissions are the **union** of all the user's roles), organization, facility assignments. No session on a non-public endpoint → `401`.
4. CSRF and `Origin` check on every unsafe method → `403 csrf-check-failed`.
5. `require(x-permission)` → `403 permission-denied` before any data access.
6. `tenant_db` opens a transaction with the organization set for row-level security; a `facilityId` the user is not assigned to → `404`.
7. Endpoint runs (restricted chart without a grant → `403 break-glass-required`).
8. Audit event written per `x-audit` (also for denials). **Audit fails closed** (§6).
9. Errors mapped to Problem Details (API_STANDARDS §9).

## 4. Permissions

### 4.1 Naming rule

`<resource>:<action>` (VG Day 1 item 3; your Stage 2 brief).

- `resource` is the collection name from the path (plural, kebab-case): `patients`, `appointments`, `notes`.
- `action` is `read`, `create` or `update` for plain CRUD; for action endpoints it is the action segment itself: `appointments:check-in`, `notes:sign`, `problems:entered-in-error`.
- Searching a PHI collection is its own action: `patients:search`.
- A child collection that is **part of its parent's record** uses the parent's permission. **PROPOSED** list: patient identifiers, related persons and emergency contacts, preferred pharmacy, restriction flag excluded (it has `patients:restrict`); coverage card images use `coverages:update`.
- A child collection with its own meaning gets its own name, prefixed when the bare word is ambiguous: `note-addenda:create`.
- Practice setup resources share `practice-setup:read|create|update`. **PROPOSED**: one administrative function; nine separate permissions add no protection.
- Each operation has exactly one permission. One permission may serve several operations.

### 4.2 Permission catalogue (draft)

The per-endpoint assignment is in [ENDPOINT_INVENTORY.md](ENDPOINT_INVENTORY.md). Owner = who implements the endpoints.

| Area (owner) | Permissions |
|---|---|
| Platform (Thulasi) | `users:read`, `users:create`, `users:update`, `roles:read`, `user-roles:update`, `audit-events:read`, `chart-access-reports:read`, `patients:break-glass`, `integration-messages:read`, `integration-messages:replay` |
| Patients (Vimal) | `patients:search`, `patients:read`, `patients:create`, `patients:update`, `patients:restrict`, `coverages:read`, `coverages:create`, `coverages:update`, `coverages:entered-in-error` (D45), `consents:read`, `consents:create`, `timeline:read`, `duplicates:read`, `duplicates:merge`, `duplicates:dismiss` (D46), `patient-merges:read` (D51), `patient-merges:undo` |
| Scheduling (Vimal) | `slots:read`, `appointments:read`, `appointments:create`, `appointments:update`, `appointments:cancel`, `appointments:check-in`, `appointments:undo-check-in` (D55), `appointments:reschedule` (D61), `appointments:status`, `status-board:read`, `scheduling-reference:read` (booking lists, D49) |
| Eligibility (Vimal) | `eligibility-checks:read`, `eligibility-checks:create` |
| Encounters and notes (Vimal) | `encounters:read`, `encounters:create`, `encounters:update`, `encounters:close`, `encounters:entered-in-error`, `vitals:read`, `vitals:create`, `vitals:entered-in-error`, `diagnoses:create`, `diagnoses:remove`, `diagnoses:entered-in-error`, `codes:read`, `notes:read`, `notes:create`, `notes:update`, `notes:sign`, `notes:cosign`, `notes:entered-in-error`, `note-addenda:create`, `favorites:read`, `favorites:update`, `after-visit-summaries:create`, `cosign-rules:read`, `cosign-rules:create`, `cosign-rules:update` |
| History (Vimal) | `problems:read\|create\|update\|entered-in-error`, `allergies:read\|create\|update\|entered-in-error`, `family-history:read\|create\|entered-in-error`, `social-history:read\|create\|entered-in-error`, `surgical-history:read\|create\|entered-in-error` |
| AI (Vimal) | `encounter-audio:create`, `transcriptions:read`, `transcriptions:create`, `note-drafts:create`, `chart-summaries:read`, `chart-summaries:create`, `ai-suggestions:decision`, `ai-settings:read`, `ai-settings:update` |
| Medications (Thulasi) | `medications:read`, `medications:create`, `medications:discontinue`, `medication-reconciliations:create`, `prescriptions:read`, `prescriptions:create`, `prescriptions:update` (drafts only, T31), `prescriptions:entered-in-error` (drafts only, T13/T34), `prescriptions:safety-check`, `prescriptions:sign-and-send`, `prescriptions:cancel`, `prescriptions:change`, `alerts:override`, `refill-requests:read`, `refill-requests:respond`, `pharmacies:read`, `medication-history:fetch` |
| Orders and results (Thulasi) | `lab-compendium:read`, `orders:read`, `orders:create`, `orders:medical-necessity-check`, `orders:sign-and-send`, `orders:cancel`, `orders:entered-in-error` (T13), `results:read`, `results:acknowledge`, `unmatched-results:read`, `unmatched-results:match`, `unmatched-results:reject` (T13/T34), `in-office-results:create` |
| Files, setup, billing, documents (Anand) | `files:create`, `files:read`, `practice-setup:read\|create\|update`, `payers:read` (payer directory, read-only; added 2026-10-23), `lab-providers:read` (lab providers, read-only; D48), `consent-requirements:read` (D59), `provider-schedules:create\|update` (D66), `note-templates:read\|create-personal` (D73, A46), `onboarding:import`, `superbills:read\|update`, `claims:read\|create\|scrub\|submit\|status-check\|correct\|void`, `payments:create`, `payments:card-session`, `remittances:read\|post`, `billing-reports:read`, `documents:read\|create\|update`, `faxes:create`, `fax-inbox:read`, `fax-inbox:file`, `ccda:import`, `ccda:export`, `inbox:read\|update\|complete`, `messages:create`, `exports:read\|create` |
| Communications and dashboard (Minalini) | `message-templates:read\|create\|update`, `communication-preferences:read\|update`, `communications:read`, `operations-dashboard:read` |
| Patient portal, B8a (Vimal; sign-in, enrollment and factor reset Thulasi; D84, D89) | Role `PAT` only: `portal-profile:read`, `portal-profile:request-change`, `portal-appointments:read\|create\|cancel\|reschedule`, `portal-booking:read`, `portal-records:read`. Staff: `portal-accounts:read`, `portal-invitations:create\|revoke`, `portal-accounts:reset-factors`. Proposed grants in NOTE_FOR_THULASI T45; they join §4.3 in the same change as core, as for T42 |

### 4.3 Draft role-to-permission matrix

**Agreed by Thulasi (issue #3, T14) with the changes below. Rows marked ‡ are clinical and remain pending the clinical advisors.** A user may hold several roles; their permissions are the **union** of those roles. Roles:

| Code | Role |
|---|---|
| FD | Front desk |
| MA | Medical assistant (rooming) |
| RN | Nurse |
| MD | Physician (MD/DO) |
| APP | Advanced practice provider (NP, PA); notes may need co-signature |
| BIL | Biller / revenue-cycle staff |
| ADM | Practice administrator (no clinical access by default, TA §3) |
| CO | Compliance / privacy officer |
| SUP | Shri platform support (**no PHI**, TA §6; replaces the `platform-admin` stand-in in Thulasi's skeleton, which had PHI access) |
| PAT | **Patient, through the portal only** (D84, P1). Own record only: the patient comes from the session, never the request, and portal paths take no patient ID (`/portal/me/...`). Signs in through a separate Keycloak realm with multi-factor, enrolled by a front-desk invitation code (D85). Holds no staff permission, so it is not a column of the staff matrix below; its portal permissions and rows come with the portal contract (B8), together with core. |
| DSP | Status board display: a shared waiting-room or hallway screen, never a person. Only `status-board:read`, and always the shared view: initials, appointment time and status (D47; in core since PR #7 db013df) |

Legend: ✓ granted · R read part only · – not granted · ‡ pending clinical advisors

| Permission group | FD | MA | RN | MD | APP | BIL | ADM | CO | SUP | DSP |
|---|---|---|---|---|---|---|---|---|---|---|
| `patients:search`, `patients:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – |
| `patients:create`, `patients:update` | ✓ | – | – | – | – | – (BIL edits coverage only) | ✓ | – | – | – |
| `patients:restrict` | – | – | – | – | – | – | ✓ | ✓ | – | – |
| `coverages:*`, `eligibility-checks:*` | ✓ | R | R | R | R | ✓ | ✓ | – | – | – |
| `consents:*` | ✓ | ✓ | ✓ | ✓ | ✓ | R | ✓ | R | – | – |
| `duplicates:read`, `duplicates:merge`, `duplicates:dismiss`, `patient-merges:read`, `patient-merges:undo` (D64: duplicate review is in the admin portal; FD sees only the `409 possible-duplicate` warning) | – | – | – | – | – | – | ✓ | R | – | – |
| `scheduling-reference:read` (booking lists, D49; in core since #21) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – |
| `pharmacies:read` (pharmacy directory, D50; batch 1; in core since #21, which added FD) | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – |
| `slots:read`, `appointments:read`, `status-board:read` | ✓ | ✓ | ✓ | ✓ | ✓ | R | ✓ | – | – | ✓ (status-board only, shared view; D47) |
| `appointments:create\|update\|cancel\|check-in` (D67: clinicians are read-only on appointments and request changes through inbox tasks) | ✓ | – | – | – | – | – | ✓ | – | – | – |
| `appointments:undo-check-in`, `appointments:reschedule` (D55, D61; in core since #21) | ✓ | – | – | – | – | – | ✓ | – | – | – |
| `appointments:status` (roomed, with provider, checked out) ‡ | ✓ (checked out) | ✓ (roomed) | ✓ | ✓ | ✓ | – | – | – | – | – |
| `timeline:read`, `encounters:read`, `notes:read`, `vitals:read`, history `:read` ‡ | – | ✓ | ✓ | ✓ | ✓ | R (signed notes, diagnoses) | – | R (investigations) | – | – |
| `vitals:create`, `allergies:create\|update` ‡ | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – |
| ‡ `encounters:create\|update\|close`, `diagnoses:*`, `notes:create\|update\|sign`, `note-addenda:create`, `after-visit-summaries:create`, other history writes | – | – | R (`notes:create\|update\|sign`, `note-addenda:create` for nursing notes; T42) | ✓ | ✓ | – | – | – | – | – |
| `notes:cosign` ‡ | – | – | – | ✓ | – | – | – | – | – | – |
| `*:entered-in-error` (clinical) ‡ | – | – | ✓ (own entries) | ✓ | ✓ | – | – | – | – | – |
| `encounters:entered-in-error` ‡ | – | – | – | ✓ | ✓ | – | ✓ (only encounters with no signed note) | – | – | – |
| `codes:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `favorites:*` ‡ | – | – | ✓ | ✓ | ✓ | – | – | – | – | – |
| `note-templates:read` (pick a template to start a note; D73, A46; in core since T42) | – | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | – |
| `note-templates:create-personal` (a clinician's own templates; D73, A46; in core since T42) ‡ | – | – | ✓ | ✓ | ✓ | – | – | – | – | – |
| AI clinical: `encounter-audio:create`, `transcriptions:*`, `note-drafts:create`, `chart-summaries:*`, `ai-suggestions:decision` ‡ | – | – | – | ✓ | ✓ | – | – | – | – | – |
| `ai-settings:read\|update`, `cosign-rules:*`, `practice-setup:*`, `onboarding:import`, `message-templates:*` | – | – | – | – | – | – | ✓ | R | – | – |
| `users:*`, `roles:read`, `user-roles:update` | – | – | – | – | – | – | ✓ | R | R | – |
| Medications and prescriptions: read ‡ | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – |
| `prescriptions:create\|update\|entered-in-error` (drafts), `medication-reconciliations:create` ‡ | – | ✓ (reconcile) | ✓ | ✓ | ✓ | – | – | – | – | – |
| `prescriptions:sign-and-send\|cancel\|change`, `alerts:override`, `refill-requests:respond`, `medications:discontinue` ‡ | – | – | – | ✓ | ✓ | – | – | – | – | – |
| Orders: `orders:create\|entered-in-error` (drafts), `in-office-results:create` ‡ | – | ✓ (point-of-care results) | ✓ | ✓ | ✓ | – | – | – | – | – |
| `orders:sign-and-send\|cancel`, `results:acknowledge` ‡ | – | – | – | ✓ | ✓ | – | – | – | – | – |
| `unmatched-results:*` ‡ | – | – | ✓ | ✓ | – | – | – | – | – | – |
| Billing: `superbills:*`, `claims:*`, `remittances:*`, `billing-reports:read` | – | – | – | R (`superbills:read`) | R (`superbills:read`) | ✓ | R | – | – | – |
| `payments:create\|card-session` (batch 1 since D58) | ✓ | – | – | – | – | ✓ | – | – | – | – |
| `payers:read` (payer directory; added 2026-10-23, in core since PR #7) | ✓ | – | – | – | – | ✓ | ✓ | – | – | – |
| `coverages:entered-in-error` (D45; in core since #7) | ✓ | – | – | – | – | ✓ | ✓ | – | – | – |
| `duplicates:dismiss` (D46; in core since #7) | – | – | – | – | – | – | ✓ | – | – | – |
| `lab-providers:read` (D48; in core since #7) | – | ✓ | ✓ | ✓ | ✓ | – | ✓ | ✓ | – | – |
| `consent-requirements:read` (D59; in core since #21) | ✓ | – | – | – | – | – | ✓ | R | – | – |
| `provider-schedules:create\|update` (D66: split from `practice-setup:*`; in core since #21) | ✓ | – | – | – | – | – | ✓ | – | – | – |
| `documents:*`, `fax-inbox:*`, `faxes:create` | ✓ | ✓ | ✓ | ✓ | ✓ | R (`documents:read` only; D71) | – | – | – | – |
| `ccda:import\|export` | ✓ | – | ✓ | ✓ | ✓ | – | – | – | – | – |
| `inbox:*`, `messages:create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |
| `exports:*` | – | – | – | – | – | – | ✓ | ✓ | – | – |
| `audit-events:read`, `chart-access-reports:read` | – | – | – | – | – | – | – | ✓ | – | – |
| `patients:break-glass` ‡ | – | ✓ | ✓ | ✓ | ✓ | – | – | ✓ | – | – |
| `integration-messages:read` (metadata only), `:replay` | – | – | – | – | – | R | ✓ | – | ✓ | – |
| `communication-preferences:*`, `communications:read` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | R | – | – |
| `operations-dashboard:read` | ✓ | – | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | – |

Notes on the matrix:

- BIL edits coverage only (`coverages:update`), not demographics (agreed, T14).
- A user with several roles gets the union of their permissions (agreed, T14).
- ADM may use `encounters:entered-in-error` only for an encounter with no signed note; this is a rule inside the service (agreed, T14).
- "Own entries" (RN entered-in-error) is a rule inside the service, not a permission.
- BIL's "R (signed notes, diagnoses)": for BIL the notes service returns signed notes only, wherever notes are read: `GET /notes/{noteId}` (a draft is `404`), the note lists, the encounter workspace's note summaries, and note versions (only those from signing on). Diagnoses come with the encounter (D73).
- Whether MA, RN may prescribe-draft or answer refills follows clinic protocol and state law: **pending clinical advisors**.
- 2026-10-24 (D49–D67): the `appointments:create|update|cancel|check-in` row had ADM `–` and CO `✓`, the reverse of DATA_OWNERSHIP §5.1 (FD, ADM) and of core; corrected to ADM `✓`, CO `–`. Duplicate review moved to ADM only (D64). Provider self-service on schedules is P1 (D66).
- 2026-10-24 (post-merge review of core PR #21): the clinician-writes row had APP `–` and BIL `✓`, a column shift from adding the DSP column on 2026-10-23; corrected to APP `✓`, BIL `–`, as in core. `medications:discontinue` (MD, APP) added to the prescribing row. APP's billing cell reads `superbills:read` only, as MD's and as core. BIL reads billing documents through `documents:read` only, with no `fax-inbox:read` (D71).
- 2026-10-26 (T42; batch 2 plan Q2–Q4, D73): RN signs and writes addenda for nursing notes only; the notes service refuses other note types for RN (DATA_OWNERSHIP §5.3). `note-templates:read` lets clinicians pick a practice or personal template (the D49 pattern); practice templates are still written under `practice-setup:create|update`. A personal template is created with `note-templates:create-personal`; the server sets the owner, and only the owner edits it.

### 4.4 Matrix gaps filled in core — gap, pending clinical advisors

The draft matrix in §4.3 has no row for 12 permissions in the catalogue. Thulasi's `backend/app/core/permissions.py` (PR #7, adjusted on PR #10) fills them in and marks them `gap`; Vimal accepted them as provisional on PR #7. They are mirrored here so the contract and the code agree (checked against core on main, 2026-10-24). Every row is **gap — pending clinical advisors**.

| Permission | FD | MA | RN | MD | APP | BIL | ADM | CO | SUP | DSP | Follows (in core) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `prescriptions:update` | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | Prescription-draft row |
| `prescriptions:safety-check` | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | Prescription-draft row |
| `prescriptions:entered-in-error` | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | Prescription-draft row |
| `medications:create` | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | Prescription-draft row; MA for rooming |
| `medication-history:fetch` | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | Prescription-draft row; MA for rooming |
| `orders:read` | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | Order-create row |
| `results:read` | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | Order-create row |
| `lab-compendium:read` | – | ✓ | ✓ | ✓ | ✓ | – | – | – | – | – | Order-create row |
| `orders:medical-necessity-check` | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | Order-create row (MA has no order drafts) |
| `orders:entered-in-error` | – | – | ✓ | ✓ | ✓ | – | – | – | – | – | Order-create row (drafts only, #228; MA has no order drafts) |
| `files:create` | ✓ | ✓ | ✓ | ✓ | ✓ | – | ✓ | – | – | – | Not in the draft matrix; ADM uploads the onboarding import file |
| `files:read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | – | – | Not in the draft matrix; ADM and CO download exports |

Settled on PR #10 (core tests in `test_permissions.py`): MA has no order drafts, only order and result reads and point-of-care results (`in-office-results:create`), as in §4.3; ADM has `files:create|read` (the onboarding import file, exports) and CO has `files:read` (exports). The file service limits which file purposes each role may use (API_STANDARDS §15).

## 5. Clinic and facility context, restricted charts, break-glass

### 5.1 Context (agreed by Thulasi, issue #3, T15)

| Level | Rule |
|---|---|
| Organization (clinic, tenant) | Taken **only** from the session; never from a header or body. One organization per user in the MVP. Row-level security enforces it (TA §6.1). |
| Facility | A user is assigned to one or more facilities of their organization. List endpoints accept a `facilityId` filter; middleware rejects facilities the user is not assigned to (`404`, API_STANDARDS §12). **Lists sent without `facilityId` must still filter to the user's facilities**: an endpoint duty, using a helper from core. No "active facility" header. |
| Patient | **Decided (D37):** any user in the organization with the right permission may access a patient at their facilities; restricted charts need break-glass (§5.2), except for the patient's care-team members; every access is audited (§6). **P1:** a practice setting that limits all charts to the care team (FRS FR-PAT-02). |
| Encounter | Write actions on an encounter (notes, diagnoses) are limited to the encounter's providers and assigned staff, enforced in the service. **PROPOSED** |

### 5.2 Restricted charts and break-glass (FRS FR-PAT-01, TA §9, CAT)

1. `POST /patients/{patientId}/restrict` with `{ reason }` sets `restricted = true` (`patients:restrict`, ADM or CO). `POST /patients/{patientId}/unrestrict` reverses it. Both are audited.
2. For a restricted patient, every patient-scoped endpoint returns `403 break-glass-required` unless the user holds a current grant. Exceptions that still work without a grant: `POST /patients/search` (summary fields only, `restricted: true`), scheduling and front-desk endpoints needed to book and check in (name and appointment only). **Agreed (T16).**
3. `POST /patients/{patientId}/break-glass` with `{ reasonCode, reasonText }` (Thulasi). `reasonCode`: `emergency-care`, `continuity-of-care`, `patient-request`, `other` (`reasonText` required for `other`). Grants access **for that user and that patient only**, for **4 hours**, revocable by CO (agreed, T16). Audited with `category: security` and shown in `GET /reports/chart-access`. The privacy officer is notified through an **inbox item for CO, never an email containing PHI** (event `break-glass.granted`, EVENTS §4; inbox is Anand's).
4. The grant never widens the user's permissions; it only lifts the restriction.
5. **Care-team members** of a restricted patient (the patient's care team in the schema) open the chart without break-glass; the access is still audited (D37). Membership is checked in `require()` from the database, never from the request.

### 5.2a Inbox items (batch 3, D77, D80)

An inbox item is visible only to users at its facility who are its assignee, hold its role, or sent it (ADM also sees items assigned at their facilities, to reassign them), **and** who hold the read permission for its kind: `results:read` for results, `refill-requests:read` and `prescriptions:read` for refills and failed prescriptions, `notes:read` for notes to sign or co-sign, `fax-inbox:read` for faxes to file (never BIL, D71), `documents:read` for documents, `claims:read`, `eligibility-checks:read`, `audit-events:read` for break-glass notices (CO), `unmatched-results:read`; messages and tasks need `inbox:read` only. An item about a restricted chart the user may not open (no grant, not on the care team; §5.2, D37) leaves out everything that could identify the patient or describe the chart: the patient, the body, the encounter, the `corrected` flag and every reply's text; a message or task title becomes "Item about a restricted chart" (system titles never name a patient). `GET /inbox?patientId=` for such a chart is refused with `403 break-glass-required` and audited with the patient ID, so the filter cannot be used to probe charts. Replies never move an item except between the assignee and the sender of a message or task (checked in the transaction). A sender must be able to open the patient and the linked record (D80); a recipient who cannot sees the link but not the record. **Pending (T43):** CO has no `inbox:*` today but receives the break-glass notice (A36); the matrix rows land with Thulasi's core change, as T42 did.

### 5.3 Clinic isolation in the database (ADR-0011)

One PostgreSQL database holds every clinic's data. Isolation does not depend on application code alone; four database rules apply together:

1. **Forced row-level security** on every clinic table, read from the settings `tenant_db` sets (`app.current_tenant_id`, `app.current_user_id`, `app.correlation_id`). A session with no clinic set sees nothing.
2. **Clinic-carrying links.** Composite foreign keys include the clinic ID, so a row can only point at a row of the same clinic (715 such keys in Sam's schema).
3. **Same-patient links.** Composite foreign keys include the patient, so a patient's record can only point at the same patient's records (77 such keys).
4. **Roles that never bypass RLS.** One role per service with the minimum grants (D23): `shri_app` (API: clinical and admin read/write with no DELETE on resource tables; `audit_event` read and insert, never update or delete; `break_glass_access` read and insert), `shri_fhir_reader` (`/fhir`: clinical read only, plus insert-only on `audit_event`; no access to `break_glass_access`), `shri_integration` (partner worker: integration tables, result filing with the reads it needs, insert-only on `audit_event`), `shri_reporting` (approved views only), `shri_migrator` (migrations only).

## 6. Audit (`x-audit`)

Middleware writes audit events (D3; TA §6: append-only, hash-chained). The contract tells it what to write.

**Audit fails closed** (agreed, T17): if the audit write fails, the request fails. Writes are audited in the same database transaction as the change; reads are audited before the response is returned.

```yaml
x-audit:
  action: R              # FHIR AuditEvent action: C create, R read, U update, E execute (actions, search)
  category: phi-read     # see table
  patient: patientId     # path parameter holding the patient ID, or "body:/patientId", or "result" (search returns IDs), or "session" (portal)
  actor: user            # optional; "partner" for /hooks/* (the partner is the actor), "patient" for /portal/*, default "user"
```

| `category` | Operations | Must audit |
|---|---|---|
| `phi-read` | Every read or search that returns patient data, including lists and search results (patient IDs returned are recorded) | Yes (FRS §6 "traceable reads") |
| `phi-write` | Every create, update, action on patient data | Yes |
| `sign` | Sign, co-sign, addendum, sign-and-send | Yes, with the signed version ID |
| `export` | Exports, C-CDA export, PDF generation, file download URLs | Yes (FRS §3.10) |
| `security` | Login, logout, failed login, permission and CSRF denials, break-glass, restriction changes, role changes | Yes |
| `ai` | AI requests (metadata only), and accept, edit, reject decisions | Yes (FRS §3.4) |
| `admin` | Practice setup, AI settings, templates, co-sign rules | Yes |
| `none` | Only: health checks, code search, a user's own favorites (`GET /me/favorites`; batch 2 plan Q9), pharmacy directory, payer directory, lab providers, lab compendium, slots, the booking reference lists (D49) and the portal's (`/portal/booking/*`, `/portal/me/slots`), inbox badge counts (`GET /inbox/summary`, counts only; D77), session reads (`GET /auth/session`, `GET /portal/auth/session`, `/me`, the event stream) | No |

Partner callbacks (`/hooks/*`) carry PHI, so they are audited as `phi-write` with the **partner as actor** (agreed, T37).

Portal operations are audited with the **patient as actor** and the patient from the session (`actor: patient`, `patient: session`; ADR-0013 §6, D84). With a portal session, `none` is allowed only on `GET /portal/auth/session`, the three `/portal/booking/*` lists and `GET /portal/me/slots`; every other one, `security` included, names the session patient. Enforced by `shri-x-audit`.

Audit records contain who, what, which record, which patient, outcome, time, request ID, and break-glass reason. **Never request or response bodies** (TA §6: "do not log unnecessary clinical payloads").

## 7. Field-level PHI classification (`x-phi`)

Every property of every schema carries `x-phi` (lint-enforced).

| Value | Meaning | Examples |
|---|---|---|
| `identifier` | One of the HIPAA identifiers that points to a person | Names, dates related to the patient (birth date, service dates), phone, email, address below state level, MRN, member ID, driver's license number, photos (card images), SSN last 4 |
| `clinical` | Health information | Diagnoses, notes, vitals, medications, allergies, results, reason for visit, transcripts |
| `financial` | Payment and insurance details | Copay, balances, payer, plan, claim amounts |
| `internal-id` | Our opaque UUIDs | `patientId`, `encounterId` |
| `none` | Not about a patient | Code descriptions, facility names, enum labels |

Used for:

1. **Logging:** values of `identifier`, `clinical` and `financial` fields are never written to application logs; `internal-id` may be (VD-G2).
2. **Minimum necessary review:** reviewers check that each `identifier` or `clinical` field in a response is needed by the screen (CONTRACT_GOVERNANCE §3).
3. **AI gateway:** each AI task declares which fields it sends; only those leave the API (VG Step 7).
4. **Exports:** de-identified exports drop or generalize `identifier` fields (FRS §3.10).
5. **Mock data:** the example lint checks `identifier` examples against the synthetic patterns (API_STANDARDS §20).

## 8. Minimum-necessary rules

| # | Rule |
|---|---|
| 1 | Lists and search return `…Summary` schemas; full detail only from the single-resource GET. |
| 2 | Front-desk and scheduling responses (appointments, status board, slots) never embed clinical content beyond the scheduled reason for visit. |
| 3 | Clinical endpoints never embed insurance or payment details, and billing endpoints embed only the clinical data billing needs (diagnosis codes, procedure codes, signed note reference). |
| 4 | `PatientSummary` (search) = id, name, birth date, sex, MRN, `restricted`, and the last 4 digits of the phone number (agreed by Minalini, M6). |
| 5 | Events and operations carry IDs and status only (EVENTS.md). |
| 6 | Error responses never contain request values or other patients' data (API_STANDARDS §9). |
| 7 | `possible-duplicate` returns candidate IDs only; the screen fetches summaries the user may see. |
| 8 | No endpoint returns full SSN (VD-SSN). Card images and license data only through `coverages:read` / `patients:read`. |
| 9 | Integration message payloads are never shown to `SUP`; metadata only. |
| 10 | AI requests send only fields declared for the task; AI logs hold metadata, never patient text (VG Step 7). |
| 11 | Shared screens (status board on a waiting-room or hallway display) show **initials plus appointment time** only (agreed by Minalini and Vimal, M11). Displays sign in with the `DSP` role, which the server always limits to that view (D47). |
| 12 | Notifications outside the app (email, SMS, push) never contain patient data or an inbox item's title or body: only "You have a new item in Shri Health" (D81). |

## 9. STRIDE threat model by endpoint group

S spoofing · T tampering · R repudiation · I information disclosure · D denial of service · E elevation of privilege. "MW" = mitigated by middleware; "EP" = endpoint's duty.

| Group | Main threats | Mitigations |
|---|---|---|
| **Auth and session** (`/auth/*`, `/me`) | S: stolen cookie, session fixation. T: forged login callback. R: denied logins. I: token leakage. D: login flooding. E: role injection | MW: HttpOnly `__Host-` cookie, PKCE + state + nonce, new session ID at login, idle timeout, MFA in Keycloak, rate limits, audit `security`. Roles only from Keycloak/our DB, never from requests |
| **Patients and search** | I: enumeration through search or errors; PHI in URLs or logs. T: unauthorized demographic edits. E: merge to hide or join records. R: who viewed a chart | EP: POST search with minimum criteria and result cap (API_STANDARDS §14); 404 for other clinics; `If-Match` on PATCH; merge only by ADM with audit and undo. MW: audit `phi-read` with returned IDs; rate limits on search |
| **Scheduling, check-in, status board** | T: double booking, booking for wrong patient. D: mass bookings. I: status board on a waiting-room screen shows too much | EP: provider-day lock (VG Step 3); idempotency on create; status board shows minimal fields (rule 2 in §8). Shared-screen mode shows initials plus appointment time (agreed, M11; §8 rule 11) |
| **Eligibility and partner-bound POSTs** | T: replayed or duplicated partner requests (double claims, double charges). R: who sent what. I: partner errors leaking | EP: `Idempotency-Key` required; MW: integration message store, audit. Partner errors mapped to Problem codes without payloads |
| **Encounters, notes, history** | T: editing a signed note; silent overwrite by another tab; changing an AI draft's origin. R: author disputes a signature. E: MA signing a note | EP: state machine guards, `If-Match`, insert-only signed versions, Provenance on signing (D8), `notes:sign` only for clinicians, encounter-level write limits (§5.1). MW: audit `sign` |
| **AI** | I: patient data sent to the model beyond need; prompt injection from transcripts or documents exfiltrating other patients' data. T: AI content entering the signed record unreviewed. E: gateway used as a skeleton key | EP: AI outputs only become drafts; human signs (FRS §3.4); output schema validation; per-task field allowlist (`x-phi`). MW: delegated token per request (§2.4); kill switches; metadata-only logs |
| **Medications and orders** (Thulasi) | T: altered prescription after signing. R: override without reason. S: forged pharmacy or lab responses | EP: signed versions immutable, override reason required, `If-Match`. MW: webhook signatures |
| **Billing and payments** (Anand) | T: claim amounts changed after scrub. I: card data on our servers. R: payment disputes | EP: claim state machine, versioned claims; card data only through the processor's hosted fields (FRS FR-RCM-03); idempotent payments |
| **Files, documents, fax, C-CDA, exports** | T: malicious upload. I: leaked download links; bulk export abuse. D: huge uploads | Anand: quarantine and scan (TA §9), size limits per purpose, short-lived URLs never logged; exports need ADM/CO and are audited `export` |
| **Partner webhooks** (`/hooks/*`) | S: forged callbacks. T: replay. D: flooding | MW: signature check, timestamp window, dedupe by partner message ID, raw store before parse, rate limits |
| **Events stream and operations** | I: events for another user or clinic. D: many open streams | MW: per-user, per-tenant filtering; thin events (IDs only); connection limits per user |
| **Admin and audit** (users, roles, practice setup, AI settings, audit search) | E: self-granting roles. R: config changes unattributed. I: audit log exposing PHI | MW: role changes need ADM and are audited; audit search only CO; audit entries contain no bodies |

## 10. Middleware guarantees vs endpoint duties

| Concern | Middleware guarantees (Thulasi) | Each endpoint must still… |
|---|---|---|
| Authentication | Valid session or `401`; CSRF on unsafe methods | Never read cookies or tokens |
| Authorization | `require(x-permission)` before the handler runs | Enforce record-level rules the permission can't express: encounter participants, "own entries", restricted-chart exceptions |
| Tenant isolation | `tenant_db` sets `app.current_tenant_id`, `app.current_user_id` and `app.correlation_id` per transaction, from the server-side session (never token claims), so forced row-level security applies; cross-clinic reads return nothing (D21) | Use only `tenant_db` and the module's repository; never open its own connection; pass the clinic to enqueued partner jobs. The database's clinic-carrying and same-patient links reject cross-clinic and cross-patient references (§5.3) |
| Facility scope | Rejects facility IDs the user is not assigned to; provides a helper that limits a query to the user's facilities | Apply the helper when a list is called without `facilityId` (T15) |
| Break-glass | Grants, expiry, audit | Return `break-glass-required` via the shared helper |
| Audit | Writes the event from `x-audit` | Supply the patient ID when it is not in the path |
| Errors | Maps `core/errors.py` exceptions to Problem Details | Raise the right error class; never build error bodies |
| Idempotency | Stores and replays keyed responses (**pending Thulasi**) | Make the business operation safe to retry |
| Concurrency | — | Check `If-Match`, return `ETag` |
| Rate limits | Applies and advertises limits | — |
| Input validation | — | Pydantic schemas matching the contract; business rules in the service |
| PHI in logs | Log redaction for `x-phi` fields; request bodies never logged | Never log PHI in custom messages |
| Encryption | TLS, encryption at rest, file keys (D3) | Never encrypt or decrypt itself |
| Events | `events.publish()` delivery, SSE filtering | Publish the right event type with IDs only |

## 11. Open items

Thulasi signed off this document on issue #3 (2026-10-22). Remaining:

| Item | Pending | Status / proposed answer |
|---|---|---|
| Idle timeout value (15 minutes) | Clinical advisors | Agreed by Thulasi; pending clinical advisors (§2.1) |
| Clinical rows of the role matrix (‡) | Clinical advisors | §4.3 |
| ~~HAPI partition design and the shared-resource question (T30, A33); how `/fhir` clients get their partition~~ | — | **Resolved by ADR-0011:** no HAPI partitions; clinic isolation is §5.3; `/fhir` clients get their clinic from the machine token (D22) |
| ~~Care-team relationship restrictions are P1~~ | — | **Decided (D37):** MVP access by role and facility, break-glass for restricted charts except care-team members, all access audited; P1 practice setting limits all charts to the care team (§5.1, §5.2) |
