# Note for Thulasi — API contract items needing your decision

From: Vimal (drafted with Claude Code) · 2026-10-22 · Becomes GitHub issues once the repository exists (VD-LOC).

Each item has a **PROPOSED** answer already written into the documents so work can continue. Please reply "agree", or give your answer. Items marked **blocks Stage 3** are needed before the shared contract components are written.

## Status after ADR-0011 (2026-10-23)

HAPI is retired (ADR-0011; D1 rewritten). T30 is resolved (struck below). Your follow-ups are in the issue "ADR-0011 follow-ups":

- remove the `/infra/hapi/` CODEOWNERS line and the folder;
- `tenant_db` sets exactly the settings the schema's RLS policies read: `app.current_tenant_id`, `app.current_user_id`, `app.correlation_id` (D21; confirm with Anand);
- the clinic comes from the server-side session, never token claims;
- the outbox is for external partners only (D25);
- machine tokens for Anand's read-only `/fhir` API (D22).

Still with you: the `enqueue()` core PR (T29). ~~The medication-list question with Anand~~ is decided: MedicationRequest (your T36, Anand's A35; D28).

**Added 2026-10-23 (issue #12):**
- the database is Amazon RDS for PostgreSQL 18 (ADR-0012, D30), provisioned with Terraform;
- the development image and CI use PostgreSQL 18 with the RDS pgvector version (0.8.2 today) and C.UTF-8 collation (D31, D33);
- one database role per service (D23);
- chart access per D37 (care-team members open restricted charts without break-glass);
- turn on automatic deletion of head branches.

## Status after your sign-off (issue #3, 2026-10-22)

All items T1–T37 are **agreed**; every "Agree, with" addition is applied to the documents in PR #2. Still with you:

- [x] Confirm the idle-timeout warning at 13 minutes with a "Stay signed in" button that counts as user activity (Vimal's answer to Minalini's M15; SECURITY_MODEL §2.1). **Confirmed** on issue #3: timed from `idleExpiresAt`, plus a notice before the 12-hour absolute limit.
- [x] Confirm `POST /orders/{orderId}/entered-in-error` is for drafts only, mirroring prescriptions (your T13 permission; ENDPOINT_INVENTORY #228, DATA_OWNERSHIP §5.5). **Confirmed** on issue #3; signed orders use cancel before specimen collection.
- [ ] Open the PR that changes `enqueue()`'s signature (T29). **Core change, all-four review:** Vimal, Anand and Minalini review it before merge. Confirmed on issue #3: it comes as a separate core PR, not in PR #7.
- [ ] Add the CODEOWNERS lines for the contract module files once Stage 3 creates them, after the `/contracts/` line (T2). The list is in the Stage 3 PR description.

## Repository and CI

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T1 | Repository setup | **Done** in PR #1. Branch protection is not available on the current GitHub plan for private repositories (ADR-0001), so the approval rules in CONTRACT_GOVERNANCE are kept by agreement until it is | ADR-0001, CONTRACT_GOVERNANCE |
| T2 | Add CODEOWNERS lines per contract module file so implementing owners must approve their sections (VD-SIGN), e.g. `/contracts/openapi/modules/billing.yaml @vimal @anand` | Yes | TOOLCHAIN §3 |
| T3 | CI jobs: bundle staleness, Spectral lint, oasdiff breaking check (with a `breaking-change-approved` label only Vimal applies), Prism smoke test, generated-client check, later Schemathesis | As listed | TOOLCHAIN §6, CONTRACT_GOVERNANCE §4–§6 |
| T4 | Node.js 24 LTS in CI; exact tool versions with a lockfile; adopt releases only once 7 days old | Yes | TOOLCHAIN §5 |
| T5 | Contract-test environment: two test clinics, one test user per role, PostgreSQL 18 with the locked schema (no HAPI since ADR-0011), Synthea data | Yes | CONTRACT_GOVERNANCE §6 |
| T6 | Serve FastAPI's own `/openapi.json` only outside production | Yes | CONTRACT_GOVERNANCE §6 |

## Session, CSRF, identity (blocks Stage 3)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T7 | Session cookie name and attributes | `__Host-shri_session`; HttpOnly; Secure; SameSite=Strict; Path=/; reference token ≥128 bits | SECURITY_MODEL §2.1, ADR-0006 |
| T8 | CSRF mechanism | Token returned by `GET /auth/session`; header `X-CSRF-Token` on POST/PUT/PATCH; plus `Origin` check | SECURITY_MODEL §2.2 |
| T9 | Idle timeout and absolute lifetime | 15 minutes idle (confirm with clinical advisors), 12 hours absolute | SECURITY_MODEL §2.1 |
| T10 | How the AI gateway calls the API for AI-02 | Short-lived delegated token per AI request, bound to user, clinic, patient and task; never a broad service account | SECURITY_MODEL §2.4 |
| T11 | Order of middleware checks and `404` vs `403` | 401 → 403 permission (before lookup) → 404 for other clinics and unassigned facilities → 403 `break-glass-required` | API_STANDARDS §12, SECURITY_MODEL §3 |

## Permissions, roles, audit, PHI

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T12 | Permission naming rule (`resource:action`; parts of a parent use the parent's permission; practice setup grouped) and the special values `public`, `authenticated`, `partner-signed` | As written | SECURITY_MODEL §1, §4.1 |
| T13 | Permission catalogue | As written (also adds `prescriptions:update` for the proposed PATCH) | SECURITY_MODEL §4.2 |
| T14 | Role list and draft matrix (FD, MA, RN, MD, APP, BIL, ADM, CO, SUP); BIL edits coverage but not demographics | As written; clinical rows to be reviewed by advisors | SECURITY_MODEL §4.3 |
| T15 | Facility scope: user assigned to facilities; `facilityId` filters; no "active facility" header | Yes | SECURITY_MODEL §5.1 |
| T16 | Restricted charts: which front-desk endpoints work without break-glass; grant length; privacy-officer notice | Search (summary only), booking and check-in work; grant 4 hours | SECURITY_MODEL §5.2 |
| T17 | `x-audit` format (`action` C/R/U/E, `category`, `patient` source) and categories | As written; no bodies in audit | SECURITY_MODEL §6 |
| T18 | Use `x-phi` for log redaction (`identifier`, `clinical`, `financial` never logged; `internal-id` allowed) | Yes | SECURITY_MODEL §7 |

## Errors, headers, idempotency (blocks Stage 3)

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T19 | `core/errors.py` emits our Problem Details shape, including replacing FastAPI's default 422 | Yes; the catalogue in API_STANDARDS §9.3 is the list of codes | API_STANDARDS §9, ADR-0003 |
| T20 | Request ID header name | `X-Request-ID`; also accept/propagate `traceparent` | API_STANDARDS §18 |
| T21 | Idempotency in middleware: scope, 24-hour retention, replay header `Idempotent-Replayed: true`, encrypted storage | Yes, in middleware | API_STANDARDS §10, ADR-0007 |
| T22 | Cursor encryption (AEAD, bound to tenant, user, endpoint; 24 h) | Yes, in middleware | API_STANDARDS §8.1, ADR-0004 |
| T23 | Rate-limit headers from IETF draft-11 (`RateLimit-Policy`, `RateLimit`) plus `Retry-After`; stricter limits on `/auth/*` and `POST …/search` | Yes | API_STANDARDS §17 |
| T24 | `/hooks/{partner}`, `/health`, `/ready` outside `/api/v1` | Yes | API_STANDARDS §2, ADR-0010 |
| T25 | `Deprecation` / `Sunset` header support in a shared response helper | Yes | ADR-0010 |
| T26 | Owner of `GET /operations/{operationId}` and `POST …/cancel` (shared platform code) | You (`backend/app/core/`) | API_STANDARDS §13 |

## Events and integration

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T27 | Event envelope (CloudEvents-style names), thin events (IDs only), naming rule | Yes | EVENTS §1–§2 |
| T28 | SSE: filtering per user, restricted-patient handling, 25 s keep-alive, 5-minute `Last-Event-ID` replay, 5 streams per user, Nginx buffering off | Yes | EVENTS §3 |
| T29 | `integration.enqueue()` writes in the caller's `tenant_db` transaction (true outbox); per-record ordering; dead-letter and replay. ~~Also for HAPI jobs; registration and check-in never block on HAPI, so both depend on this.~~ Since ADR-0011 the outbox carries partner messages only (D25) | Yes | DATA_OWNERSHIP §3.1, §3.3 |
| T30 | ~~Tenant isolation inside HAPI (with Anand)~~ **Resolved by ADR-0011:** no HAPI partitions; `tenant_db` sets the schema's RLS settings from the server-side session, and the database's clinic-carrying links do the rest (D21, SECURITY_MODEL §5.3). | One HAPI partition per organization, chosen by the FHIR client from the request tenant | DATA_OWNERSHIP §3.4 |

## Your endpoints in the inventory

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| T31 | Add `GET /prescriptions/{prescriptionId}` and `PATCH /prescriptions/{prescriptionId}` (VG Step 1 requires `If-Match` on prescription updates, but CAT has no update endpoint) | Add | ENDPOINT_INVENTORY #121–122 |
| T32 | Add `GET /orders/{orderId}` | Add | #136 |
| T33 | Requisition and labels return a file download link instead of PDF bytes | Yes | #140–141, API_STANDARDS §15 |
| T34 | Entered-in-error for prescription drafts; `POST /unmatched-results/{id}/reject`; order cancel cut-off (before specimen collection) | Add / yes | DATA_OWNERSHIP §5.4–5.6 |
| T35 | Review the prescription, order and result state machines; RxChange flow | Please review | DATA_OWNERSHIP §5.4–5.6 |
| T36 | Medication list represented as MedicationRequest (US Core) or MedicationStatement (with Anand) | MedicationRequest, per US Core **Decided (D28):** Anand agreed (A35) | DATA_OWNERSHIP §2.2 |
| T37 | Sign off your rows (#1–27, #116–147) | — | ENDPOINT_INVENTORY |
| T38 | **New permission `payers:read`** for the read-only payer directory (`GET /payers`, #230–231; batch 1). Proposed grants: FD, BIL, ADM (SECURITY_MODEL §4.3). Please add it to `CATALOGUE` and the role map in `core/permissions.py` (PR #7). | Add | SECURITY_MODEL §4.2, §4.3 |
| T39 | **Shared status-board displays.** `GET /status-board?view=shared` returns initials, time and status only (SECURITY_MODEL §8 rule 11), but the screen chooses the view. Should a display-only role force `shared` on the server? | Your call | `scheduling.yaml` |
