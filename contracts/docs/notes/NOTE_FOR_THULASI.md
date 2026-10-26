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
| T38 | **New permission `payers:read`** for the read-only payer directory (`GET /payers`, #230–231; batch 1). Proposed grants: FD, BIL, ADM (SECURITY_MODEL §4.3). Please add it to `CATALOGUE` and the role map in `core/permissions.py` (PR #7). | **Done** in PR #7 (bd11128): FD, BIL, ADM | SECURITY_MODEL §4.2, §4.3 |
| T39 | ~~**Shared status-board displays:** should a display-only role force `shared` on the server?~~ **Decided (D47):** role `DSP` with only `status-board:read`, always the shared view. Already in core (PR #7, db013df): the server forces the shared view for `DSP`; thank you. | Done | SECURITY_MODEL §4.3 |
| T41 | **Batch 1 follow-up (2026-10-24, D49–D67):** (1) five more permissions for `CATALOGUE` and the role map: `scheduling-reference:read` (FD, MA, RN, MD, APP, BIL; D49), `pharmacies:read` (FD, MA, RN, MD, APP; D50), `patient-merges:read` (ADM; CO read; D51), `appointments:undo-check-in` and `appointments:reschedule` (FD, ADM; D55, D61), `consent-requirements:read` (FD, ADM; CO read; D59), `provider-schedules:create|update` (FD, ADM; D66); FD loses `duplicates:read` (D64). *Corrected 2026-10-24:* CO reads `patient-merges` and `consent-requirements` ("R" in §4.3), as core has it since #21: a compliance officer investigating a privacy complaint needs both; read-only and audited. (2) Your contracts to approve (x-owner thulasi): `platform.yaml` (#1–6, #14, #19; D52, D53) and `GET /pharmacies` in `medications.yaml` (D50). (3) A frontend CI job for `frontend/` (lint, typecheck, vitest), as for Minalini's PR #19. | Please review | SECURITY_MODEL §4.3; `contracts/openapi/modules/platform.yaml`; issue #12 |
| T40 | **Three more permissions from batch 1:** `coverages:entered-in-error` (FD, BIL, ADM; D45), `duplicates:dismiss` (ADM; D46), `lab-providers:read` (MA, RN, MD, APP, ADM, CO; D48). Please add them to `CATALOGUE` and the role map. `payers:read` (T38) is done, for FD, BIL and ADM as in §4.3. | Add | SECURITY_MODEL §4.2, §4.3 |
| T42 | **Batch 2 (encounters, notes, history; 2026-10-24, D73).** Core changes, landing together with the SECURITY_MODEL §4.3 rows so the whole-matrix test stays green: (1) RN gets `notes:sign` and `note-addenda:create`; the notes service limits them to nursing notes (DATA_OWNERSHIP §5.3; ‡ clinical advisors); (2) a new `note-templates:read` (MD, APP, RN, MA, ADM, CO) for Anand's template GETs, and `note-templates:create-personal` (MD, APP, RN) if Anand agrees (A46). Batch 2's own operations use only permissions already in core. Also: `GET /me/favorites` is audited `none` (added to the SECURITY_MODEL §6 list), and BIL's `notes:read` returns signed notes only (a notes-service filter that also applies to the encounter workspace and note versions). | Please review; one core PR with the matrix rows | SECURITY_MODEL §4.3, §6; BATCH2_PLAN §6 |
| T43 | **Batch 3: inbox (2026-10-26; D77–D81).** (1) **CO gets `inbox:read`, `inbox:update` and `inbox:complete`** in core, because the break-glass notice for the privacy officer is an inbox item (A36, T16); the SECURITY_MODEL §4.3 row lands in the same PR, as for T42, so the whole-matrix test stays green. (2) `inbox.item-assigned` for a **role** assignee goes to the role's users at the item's facility; new event `inbox.item-completed` (EVENTS §4). (3) **Notifications outside the app** (email, SMS, push; your integration engine) carry no patient data, titles or bodies, only "You have a new item in Shri Health" (D81; SECURITY_MODEL §8 rule 12). (4) For batch 5: `result.received` with `critical: true` starts the critical-result escalation (covering clinician, then practice lead, D78); acknowledging (#144) completes the `result-review` item. | Please review; one core PR with the matrix row | SECURITY_MODEL §5.2a, §8; EVENTS §4; BATCH3_PLAN.md §11 |
| T45 | **Portal batch B8a (2026-10-26, D89; ADR-0013).** The contract is written; these are yours to build and approve: (1) **x-owner Thulasi:** the portal sign-in and session operations (#260–264), `POST /portal/enrollments` (#265) and `POST /patients/{patientId}/portal-account/reset-factors` (#289), as the ADR's Consequences assign them; (2) **core:** `portalSessionCookie` (`__Host-shri_portal`, now in the contract and SECURITY_MODEL §2.3), `current_patient`, the route guards both ways, the own-record `404` check before every `/portal/me/...` endpoint, and the middleware reading the new `x-audit` values `actor: patient` and `patient: session`; (3) **permissions**, landing with the SECURITY_MODEL §4.3 rows so the whole-matrix test stays green, as for T42: role `PAT` with only `portal-profile:read`, `portal-profile:request-change`, `portal-appointments:read`, `portal-appointments:create`, `portal-appointments:cancel`, `portal-appointments:reschedule`, `portal-booking:read`, `portal-records:read`; staff `portal-accounts:read` (FD, ADM; CO read), `portal-invitations:create` and `portal-invitations:revoke` (FD, ADM), `portal-accounts:reset-factors` (FD, ADM, after the ID check); (4) **lint:** `shri-public-allowlist` now allows `/portal/auth/login`, `/portal/auth/callback` and `/portal/enrollments`; `shri-security` refuses the staff cookie under `/portal/` and the portal cookie anywhere else; (5) **spelling:** the contract path is `/portal/enrollments` (U.S. spelling, D18); please use it in ADR-0013 (#67), which still says `/enrolments`. (6) **added after Minalini's review (2026-10-26):** **D92 amends ADR-0013, please confirm on #73:** `POST /patients/{patientId}/portal-account/disable` and `…/enable` (#290–291; x-owner you), ADM only, `portal-accounts:disable` and `portal-accounts:enable`, a required reason, audited `security`; disable ends every portal session of the patient at once, with its realm session, and disables the realm user; enable leaves password and factors alone. Enrollment also accepts the invitation code in any case and without dashes, normalized before the HMAC check (upper case, dashes removed, `I`/`L` → `1`, `O` → `0`), and refuses a missing or foreign `Origin` with `403 csrf-check-failed` (ADR-0013 §5). | Please review the PR; one core PR with the matrix rows | ADR-0013; D92; SECURITY_MODEL §1, §2.3, §4.2, §6; ENDPOINT_INVENTORY #260–291 |
