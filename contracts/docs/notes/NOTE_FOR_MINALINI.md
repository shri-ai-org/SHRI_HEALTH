# Note for Minalini — API contract items needing your decision

From: Vimal (drafted with Claude Code) · 2026-10-22 · Becomes GitHub issues once the repository exists (VD-LOC).

Each item has a **PROPOSED** answer already written into the documents so work can continue. Please reply "agree", or give your answer. Items marked **blocks Stage 3** are needed for the shared contract components; the mock server comes to you first (VG §4).

## Status after your sign-off (issue #5, 2026-10-22)

Applied in PR #2: M1, M2, M3 (`orval` with a custom mutator), M4 (one fetch wrapper; **your design task: the 412 "record changed" screen**), M5 (FRS v1.2 is the source for field lists), M6, M8 (your design task), M9, M11 (initials plus appointment time), M12, M13 (JPEG and PNG for P0; HEIC only if Anand's file service converts it), M14.

Vimal's answers to your questions:

- **M7:** yes, a full phone number is an identifier. It is only ever sent in the body of `POST /patients/search`, never in a URL. Exact match on the full number (normalized digits) only; no partial-number search in the MVP, because partial search makes it easy to fish through records (API_STANDARDS §14.2).
- **M15:** the idle timeout is 15 minutes (Thulasi, T9, pending the clinical advisors) and 12 hours absolute. Warn at 13 minutes, two minutes before logout, with a "Stay signed in" button that counts as user activity (calls `POST /auth/refresh`). **Confirmed by Thulasi** (issue #3): time the warning from `idleExpiresAt` returned by `GET /auth/session`, and show a notice before the 12-hour absolute limit (`expiresAt`), which cannot be extended. ADR-0006 stays Accepted (SECURITY_MODEL §2.1).

Still with you: M10 (EVENTS §4 review) and M16 (rows #220–226). Also: please review Thulasi's separate core PR changing `enqueue()` when it opens (core change, all four review).

## Original items

| # | Item | PROPOSED answer | Where |
|---|---|---|---|
| M1 | JSON property and query parameter casing (**blocks Stage 3**) | camelCase | API_STANDARDS §3 |
| M2 | List shape: `{ items, nextCursor }`, no total counts by default, "load more" rather than page numbers (**blocks Stage 3**) | Yes | API_STANDARDS §8, ADR-0004 |
| M3 | TypeScript client generator and data-fetching library | Your choice: `orval` 8.44.0 (types + hooks) or `openapi-typescript` 7.13.0 (types only), versions checked 2026-10-22 | TOOLCHAIN §1, §7 |
| M4 | Generated client must: send `X-CSRF-Token` on POST/PUT/PATCH; create one `Idempotency-Key` per user action and reuse it on retry; keep the latest `ETag` and handle `412`/`428` (reload, show difference); switch on Problem `code`, never on text | Agreed: one fetch wrapper handles CSRF, `ETag`/`If-Match` and Problem `code`; the `Idempotency-Key` is created per user action and reused on retry. **Minalini designs the 412 "record changed" screen** (her design task, as for M8) | SECURITY_MODEL §2.2, API_STANDARDS §9–§11 |
| M5 | Where are the existing screens? We need their field lists so the contract matches what they show | — | — |
| M6 | Patient search result fields (`PatientSummary`) | id, name, birth date, sex, MRN, `restricted`, last 4 digits of phone | SECURITY_MODEL §8 rule 4 |
| M7 | Patient search needs an exact identifier or two criteria (e.g. last name + birth date); at most 50 results | Yes | API_STANDARDS §14.2 |
| M8 | Screen flows driven by errors: `possible-duplicate` (show candidates, override with reason), `break-glass-required` (reason dialog), `session-expired` (re-login), `feature-disabled` (hide AI) | Please design | API_STANDARDS §9.3 |
| M9 | Long-running actions: `202` + operation; screen listens for `operation.completed` on the event stream or polls `GET /operations/{id}` | Yes | API_STANDARDS §13 |
| M10 | Screens that need live updates and which events | As in the "Browser" rows | EVENTS §4 |
| M11 | Status board on a waiting-room display: initials only | Yes | SECURITY_MODEL §9 |
| M12 | Mock server: run locally with `npx` and also a shared staging mock redeployed on merge; static examples first | Yes | TOOLCHAIN §7 |
| M13 | File uploads from the browser: request upload URL, `PUT` directly, then attach `fileId`; insurance-card types JPEG, PNG, HEIC (phones) | Please confirm HEIC is needed | API_STANDARDS §15 |
| M14 | Input formats: phone E.164, U.S. state as USPS two-letter code, ZIP or ZIP+4, dates `YYYY-MM-DD`, times shown in the facility's time zone | Yes | API_STANDARDS §6 |
| M15 | Login in the browser: redirect to `/api/v1/auth/login`; after return, `GET /auth/session` for user, CSRF token and idle expiry; warn before idle timeout | Yes (with Thulasi) | SECURITY_MODEL §2 |
| M16 | Sign off your rows (#220–226) | — | ENDPOINT_INVENTORY |
