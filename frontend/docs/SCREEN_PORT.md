# Screen port: Minalini's apps on the SHRI_HEALTH API

The front desk (`front-office/`, from shri-ai-org/care-entry at `1671026`) and the clinician app (`doctors-portal/`, from shri-ai-org/AIEMR_mockups `vimal` at `deae0d3`) are copied file for file. Only their data layer changes: mock data is replaced by the generated client (`src/api/generated/`). Each screen's diff against its source shows only import and data-call lines.

`patient-self-registration/` is copied but not connected (cut from the demo, D108).

## Status by screen

| Demo step (D108) | Screen | App | Data | Previews |
|---|---|---|---|---|
| 7, 8 Templated note and sign | Consultation note (`src/shri/notes/ConsultationPage.tsx`, `NoteAuthoring.tsx`) | doctors-portal | In progress | `docs/previews/doctors-portal/consultation-note/` |
| 7 Diagnoses | Problems and coding (`src/shri/notes/ProblemsPage.tsx`) | doctors-portal | Mock | — |
| 9 Prescribe | Prescription (`src/shri/notes/PrescriptionPage.tsx`) | doctors-portal | Mock (the backend is #169, a draft) | — |
| 10 Follow-up | No screen in either app | — | — | — |

## TEMPORARY — no source screen

These are Claude-built screens kept until after the demo, because neither source app has a screen for their demo step. Minalini decides after the demo.

| Demo step | Screen | Files |
|---|---|---|
| 3 Insurance | Coverages, card photos, entered-in-error | `src/features/patients/insurance/` (8 files) |
| 6 Room | Rooming: vitals, allergies, current medications, reason | `src/features/clinical/RoomingPage.tsx`, `DrugPicker.tsx`, `MedicationsSection.tsx`, `parts.tsx`, `vitals.ts`, `clinical.test.tsx` |

They use the design-system barrel (`src/design-system/index.ts`), so the whole design system stays with them. Neither is mounted in an app yet: the old app shell (`src/main.tsx`, `src/app/FrontDeskApp.tsx`) was deleted. They need a host before demo steps 3 and 6 can be walked.

## Still on mock data, and why

(Filled in per screen as each is connected.)

## Contract gaps for Vimal

(Filled in per screen as each is connected.)

## Check-in and reschedule check (2026-11-10)

**The three "Waiting for consultation" rows** at 5:11 AM (Mariela 10:20 AM `d17199bb`, Kaia 11:00 AM `8bc3867c`, Mariela 12:40 PM `6725be4d`) were not reschedules. Each was booked and then checked in by `dev.fd` between 4:38 and 5:07 AM clinic time (one `checked-in` visit step each, a new check-in encounter each, no `rescheduledFrom` link). They were test leftovers, and the screen showed them correctly. Reset through the API with `undoCheckIn` (reason "Synthetic test cleanup"): each is `booked` again and its check-in encounter is entered-in-error (D55). Backup first: `~/shri-demo-backups/shri-demo-before-resched-tests-20261110-1643.dump`; a test restore matched the backup-time counts (24 appointments, 11 encounters, 16 visit steps, 7 patients).

**Backend behavior, tested on new bookings for Theo Brandt (synthetic) through the API:**
- Reschedule of a booking not checked in: the old one is `cancelled` (reason `pat`), the new one is `booked`, with no visit status and no encounter carried over. Correct.
- Reschedule of a checked-in booking: refused with **409 `invalid-state-transition`** (current state `checked-in`); the check-in, its encounter and its status-board entry stay as they were. Correct.
- Cancel: `cancelled`, with no visit status, and absent from the status board and the doctors' queue. Correct.

No backend bug, so nothing goes to Vimal from this check.

| # | Finding | Who | Where | State |
|---|---|---|---|---|
| 69 | Front office, with the API: the visit icon's tooltip said "Outpatient (OPD)" (India's term); now "Visit today" | — | Patient status icons (lists, profile) | Fixed |
| 70 | Front office, at 390 px: Visit History squeezed each upcoming visit's title to one letter beside the status and Check in; on a phone the title now takes the first line and the status and actions wrap below | — | Profile, Visit History | Fixed |
| 71 | "Done today" counts today's cancelled bookings (care-entry files a cancelled booking of today under Done). The cards and the list agree; whether cancelled belongs under Done is a wording question | Minalini (question) | Outpatients cards | As care-entry |
| 72 | The live stream allows 5 open streams per user (`MAX_STREAMS_PER_USER`); several tabs signed in as the same dev user get 429 and fall back to the timed refresh | Thulasi (question: enough for a shared desk login?) | Live updates | Note |
