# Note for Vimal: patient portal endpoints the screens need

From: Minalini (drafted with Claude Code) · 2026-10-24 · for guide 04 Step 8 (P1) and the handoff "screen inventory and missing endpoints → Vimal"

The React patient portal (`frontend/src/features/portal/`) follows the old Shri portal's screens and runs on a mock (`api/mockPortalApi.ts`, synthetic data only). The `/portal` module is not in the contract yet (P1, D19). Below is what the screens call, so you can draft `contracts/openapi/modules/portal.yaml`. Shapes are in `api/types.ts` and follow API_STANDARDS (camelCase, `…At` instants in UTC, Money as decimal strings). The screens depend only on the `PortalApi` interface in `api/portalApi.ts`, so switching to the generated client changes nothing else.

## Endpoints (proposed paths under `/api/v1/portal`)

| Screen | Call | Notes |
|---|---|---|
| Sign-in, session | `POST /portal/auth/login`, `POST /auth/logout`, `GET /auth/session`, `POST /auth/refresh` | Patient identity is separate from staff: Thulasi. Same cookie session and idle rules (Q20). |
| Forgot username | `POST /portal/auth/username-reminder` `{ firstName, lastName, birthDate, email, postalCode, phone }` | Always `202` (no account enumeration). Rate-limited. |
| Forgot password | `POST /portal/auth/password-reset` `{ email }` | Always `202`. |
| Registration (11 pages) | `GET /portal/reference-lists`, `POST /portal/registrations`, `POST /portal/registrations/summary` (file) | The practice approves before the account opens. No SSN (D43). Medical, family, social and surgical history arrive as patient-reported data for clinician review. |
| Alerts and Reminders | `GET /portal/alerts` | Today's and the next appointments. |
| Demographics | `GET /portal/demographics`, `PUT /portal/demographics` (`If-Match`) | Includes employer and emergency contact. Do name changes need front-desk approval? |
| E-Signature | `GET /portal/signature`, `PUT /portal/signature` (PNG) | Stored through Anand's file service. |
| Change password | `POST /portal/me/password` `{ email, currentPassword, newPassword }` | Field error `pointer: /currentPassword`, code `incorrect`. |
| Appointments | `GET /portal/appointments`, `GET /portal/appointments/{appointmentId}`, `POST /portal/appointments/{appointmentId}/cancel` | No DELETE (D14). |
| Schedule / reschedule | `GET /portal/facilities`, `GET /portal/appointment-categories`, `GET /portal/providers?facilityId=`, `POST /portal/slots/search` `{ date, facilityId, providerId, durationMinutes }`, `POST /portal/appointments`, `POST /portal/appointments/{appointmentId}/reschedule` | The patient picks a 15/30/45/60-minute duration and a reminder channel, as in the old portal. `409 booking-conflict` when the slot is taken. `Idempotency-Key` on writes. |
| Visit summary | `GET /portal/visit-summaries/{visitSummaryId}` | After the note is signed and released. |
| Video Consult | `POST /portal/appointments/{appointmentId}/video-join` → `{ joinUrl }` | Self-hosted Jitsi; room opens 15 minutes before. |
| Messages | `GET /portal/messages?folder=inbox\|sent\|trash`, `POST /portal/messages/{messageId}/read`, `POST /portal/messages`, `POST /portal/messages/trash` `{ messageIds }`, `POST /portal/messages/remove-from-trash` `{ messageIds }`, `GET /portal/message-recipients` | "Delete" in Trash hides the message from the patient only; the practice keeps its copy. Subjects are the old fixed list. |
| Test Results | `GET /portal/results`, `GET /portal/results/{resultId}` | Released results only, with the performing lab and per-component flag. |
| Health Issues, Allergies, Immunization | `GET /portal/health-issues[/{id}]`, `/portal/allergies[/{id}]`, `/portal/immunizations[/{id}]` | Old fields: occurrence, referred by, notes; route, site, expiration. Exclude entered-in-error (D24). |
| Health Trends | `GET /portal/vitals` | All encounters (the old portal read one hard-coded encounter). |
| Prescriptions | `GET /portal/prescriptions`, `POST /portal/refill-requests` `{ prescriptionIds, pharmacyId, message }`, `GET /portal/refill-requests/{id}` | Controlled substances `refillable: false`. Lands in the provider inbox; Thulasi's e-prescribing. |
| Pay Bills | `GET /portal/bills`, `POST /portal/payments` `{ billId, amount, paymentToken }` | Card data only through the processor's hosted fields (Q17). Anand's billing. |
| Patient Documents | `GET /portal/documents?source=patient\|provider`, `POST /portal/documents` (multipart, 10 MB, PDF/JPEG/PNG), `GET /portal/documents/{documentId}/content` | Anand's file service; uploads scanned before use. |
| Reports | `GET /portal/patient-report`, `GET /portal/patient-report/ccr`, `/ccd`, `/pdf` | CCR and CCD as zip, report as PDF (Anand's C-CDA). |
| Document Template | `GET /portal/document-templates[/{id}]`, `PUT /portal/document-templates/{id}` `{ values, signature? }`, `POST /portal/document-templates/{id}/send-for-review`, `POST /portal/document-templates/{id}/clear` | Review needs a signature (`business-rule-violation`, pointer `/signature`). |

## Questions for you

1. One `portal` module, or portal operations inside each owning module with a `portal` tag?
2. Patient role and permissions in SECURITY_MODEL §4 (a `PAT` role, own record only).
3. Release rules: which results and notes the portal shows, and after what delay (FRS 3.8).

## Not carried over from the old portal

The old Lumen backend was not ported. It read OpenEMR's MySQL directly with raw SQL, had hard-coded patient IDs and SQL injection (its own ARCHITECTURE.md §7 lists them), and its archive contains secrets and real-looking billing PDFs. None of its code or data is in this repository. Only the screens and flows were reused (FRS 3.8).
