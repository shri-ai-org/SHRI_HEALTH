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
| 73 | Fixed (2026-11-10): Visit History and the check-in toggle read a checked-in visit's place from care-entry's queue token, which exists only for a check-in made on that page; a visit checked in elsewhere (another tab or desk, or before a reload) showed a plain "Checked in" tag and no undo. With the API a server booking now takes it from the server's visit status (`serverQueueStatus`): checked in → Waiting (with the undo toggle), roomed or with the provider → In consultation, checked out → Completed | — | Profile Visit History, check-in toggle | Fixed |
| 74 | Fixed (2026-11-10): past visits that didn't finish said "Incomplete" (care-entry's word). With the API: booked and never checked in → **Missed**; a recorded no-show → **No-show**; checked in but never checked out → **Not checked out**. Label only; the badge's tone is unchanged | — | Profile Visit History | Fixed |
| 75 | Demo data: today's and earlier cancelled test bookings stay in Visit History. No operation removes or voids a booking (D14: no DELETE; a cancellation is a permanent record), so it can't be cleaned through the API. Options: leave them (a U.S. chart shows cancellations), or reset the demo database to Anand's seed (`python -m app.db.seed reset`, with #259's 500 synthetic patients) after a backup, which also drops the patients registered in testing | Minalini (decision) | Demo data | Proposal |
## Connection audit (2026-11-10)

Checked against the code and the running screens, not this file's older rows. **Method:** every route in `front-office/src/App.tsx` and `doctors-portal/src/atlas/registry.ts` (routed screens) was opened in Playwright on `minalini/fe4-connect-built` (`2b64977a`, local only), which contains `minalini/fe3-clinical-list` (`f082f2b0`, local only) and `minalini/fe2-front-office` (`4ee86bfa`, **pushed**, draft #261 on #243). The API was the local stack (`local/demo-stack-3`) as `fd` (front office) and `md` (doctors' portal). Every `/api/v1` response was recorded. The app shell's own calls don't count toward a screen: front office `GET /booking/facilities`, `/booking/appointment-types`, `/booking/providers`; doctors' portal `GET /me`, `/booking/facilities`.

**Contract on origin/main (`5c5b8236`):** 231 operations, **138 built** in `backend/app`. Added since 5 Nov: `listPatientAppointments` (#241, #242). Already in the contract but not used by either app: `createNoteDraft`, `runEligibilityCheck`, `recordPayment`, `listPharmacies`, `cosignNote`, `removeEncounterDiagnosis`. In the contract but **not built**: `getChartSummary`/`createChartSummary` (#264, #267 open), `setPreferredPharmacy`, `listProblems`/`addProblem`, the history lists (#265 helpers open), the inbox, `createMessage`, provider/location/schedule setup, the portal, `createTranscription`. **Not in the contract at all:** orders, results, imaging reports, referrals, a co-sign worklist, care team. `generalPractitionerId` is in the contract (7 mentions).

**Status:** connected = the screen's own data comes from `/api/v1`; partly = some parts real, some sample; sample = no screen calls; hidden = not in the U.S. demo (hidden or unlinked with the API). **Why not:** (a) the API is built on main, not connected yet; (b) no API yet; (c) not in the U.S. demo.

### Front office

| Screen | Route | Status | API calls (beyond the shell) | Branch | Why not connected |
|---|---|---|---|---|---|
| Home | `/` | connected | `GET /appointments` | fe2 | — (to-do card: (c)) |
| Recent patients | `/patients` | connected | `GET /appointments`, `POST /patients/summaries` | fe2 | — |
| Outpatients (check-in, no-show, undo) | `/patients/outpatients` | connected | `GET /appointments`, `POST /patients/summaries` (+ check-in, status, undo on action) | fe2 | — |
| Patient profile and visit history | `/patients/:id` | connected | `GET /patients/{id}`, `GET /patients/{id}/appointments` (+ `PATCH /patients/{id}` on edit) | fe2 | age/address edit: decision (gap 57) |
| Registration (from the Angular wizard) | `/register/new` | connected | `GET /payers` (+ `POST /patients`, coverage on submit) | fe2 | — |
| Schedule Appointment | `?flow=schedule` | connected | `GET /slots`, `GET /appointments`, `POST /patients/summaries` (+ `POST /appointments`) | fe2 | — |
| Reschedule | `?flow=reschedule` | connected | `GET /slots`, `GET /patients/{id}/appointments` (+ `POST …/reschedule`) | fe2 | — |
| Check-out (follow-up, revisit, summary) | `?flow=checkout` | partly | `GET /appointments/{id}`, `GET /patients/{id}` (+ decline, summary link, check-out) | fe2 | copay: (a) `recordPayment` (needs your OK) |
| Insurance (temporary) | `/temporary/insurance/:id` | connected | `GET /patients/{id}/coverages` | main's | eligibility: (a) `runEligibilityCheck`; not in care-entry (gap 18) |
| Rooming (temporary) | `/temporary/rooming/:id` | connected, wrong role | `GET /encounters/{id}` → 403 as `fd` | main's | rooming is MA/RN work; FD can't read encounters |
| Doctor directory | `/doctors` | connected | providers from the shell call | fe4 | — |
| Doctor profile | `/doctors/:id` | connected | `GET /slots`, `GET /appointments` | fe4 | leave: (b) `createProviderSchedule` not built (Anand) |
| Register doctor | `/doctors/register` | sample | none | — | (b) `createProvider` not built (Anand) |
| Inpatients | `/patients/inpatients` | hidden | (redirects to the list) | — | (c) |
| Guest pass, print, enquiry, MLC | `/services/*` | hidden | none | — | (c) India-only |
| Billing counter, payments, receipt | `/billing`, `/payments/:id`, `…/receipt` | hidden | none | — | (c) India-only (U.S. copay: check-out row) |
| Activity & Analytics | `/activity-analytics` | hidden | none | — | (c) not in the demo |
| Redirects and not found | `/outpatients`, `/admissions*`, `*`, … | n/a | none | — | — |

### Doctors' portal

| Screen | Route | Status | API calls (beyond the shell) | Branch | Why not connected |
|---|---|---|---|---|---|
| My Day | `/`, `/clinician` | partly | `GET /status-board`, `GET /slots`, `GET /appointments` | fe3 | own schedule: (a) `practitionerId` on `/me` (#221); admissions/ICU/critical: (c); brief cards: (b) chart summary not built (#264, #267) |
| AI morning brief | `/brief` | sample | `GET /status-board` only | — | (b) `getChartSummary` not built (Vimal, #267 open) |
| OPD queue (My patients) | `/op-queue` | connected | `GET /status-board` (+ `POST …/status` on Call) | fe3 | — |
| Consultation note (draft, sign, addendum) | `/encounter/:id/note` | connected | `GET /encounters/{id}`, `GET /encounters/{id}/notes` | fe4 | AI draft from dictation: (a) `createNoteDraft` |
| Problems and coding (diagnoses) | `/encounter/:id/problems` | partly | `GET /encounters/{id}` (+ ICD-10 search, `addEncounterDiagnosis`) | fe4 | remove: (a) `removeEncounterDiagnosis`; problem list: (b) `listProblems` not built (Vimal) |
| Prescription | `/encounter/:id/rx` | partly | `GET /encounters/{id}` (+ RxNorm search, `createPrescription`, safety check, sign and send) | fe4 | pharmacy choice: (a) `listPharmacies`; preferred pharmacy: (b) `setPreferredPharmacy` not built |
| Patient instructions + follow-up | `/encounter/:id/instructions` | partly | `GET /encounters/{id}`, bookable types and providers (+ `PUT …/follow-up`) | fe4 | sending to the patient: (b) `createMessage` not built (Minalini) |
| Templates | `/clinician/templates` | partly | `GET /note-templates` | fe4 | order sets: (b) no orders API |
| Co-sign | `/clinician/cosign` | sample | none | — | (b) no "awaiting my co-sign" list (`cosignNote` exists; Vimal) |
| Patient record (overview) | `/patient/:id`, `/patient/:id/record` | partly | patient, allergies, coverages, encounters, notes, `GET /patients/{id}/medications`, `/vitals` | fe3/fe4 | admissions: (c) |
| Timeline | `/patient/:id/timeline` | connected | encounters, notes, medications, vitals | fe4 | — |
| Consultation notes | `/patient/:id/notes` | connected | `GET /patients/{id}/encounters`, `…/notes`, `GET /notes/{id}` | fe3 | — |
| Appointments | `/patient/:id/appointments` | connected | `GET /appointments` (31-day windows) | fe3 | — |
| Prescriptions (list) | `/patient/:id/prescriptions` | connected | `GET /patients/{id}/medications` | fe4 | — |
| Current condition | `/patient/:id/condition` | sample (frame only) | the chart frame's calls only | — | (b) `listProblems` not built |
| Test results | `/patient/:id/results` | sample (frame only) | the chart frame's calls only | — | (b) no results API (Thulasi) |
| Imaging reports | `/patient/:id/reports` | sample (frame only) | the chart frame's calls only | — | (b) no imaging/results API (Thulasi) |
| New orders, orders, order sets, stewardship | `/encounter/:id/orders*`, `/orders/*` | sample | none | — | (b) no orders API (Thulasi) |
| Results inbox, result detail | `/results/*` | sample | none | — | (b) no results API (Thulasi) |
| Session templates, blocks and leave | `/schedule/*` | sample | none (`/schedule/blocks`: status board) | — | (b) `createProviderSchedule` not built (Anand) |
| Referrals | `/referrals` | sample | none | — | (b) no referrals API |
| Clinician assistant | `/assistant/clinician` | sample | none | — | (b) chart Q&A in #268, #269 (Vimal, open) |
| Inpatients, cohorts | `/ip/patients`, `/patients/cohorts` | hidden | status board (shared frame) | — | (c) |
| Inpatient note, assessment, discharge, med rec, death | `/ip/*`, `/discharge/board`, `/encounter/:id/{discharge-summary,med-rec,death}` | sample | none | — | (c) |
| Telehealth (queue, session, tele-Rx) | `/tele/*` | sample | none | — | (c) no telehealth in the U.S. demo |
| Stroke (19 screens), stroke assistant, AI console | `/stroke/*`, `/assistant/stroke` | sample | none | — | (c) |
| Radiology worklist, study viewer | `/radiology/*` | sample | none | — | (c) |
| ADR reporting | `/pharmacy/adr` | sample | none | — | (c) India pharmacovigilance |

### Can connect now (a), in the order of Vimal's demo checklist on #243

1. Step 3, eligibility: `runEligibilityCheck` on the insurance panel (medium; the panel is main's, not care-entry's: placement needs your OK).
2. Step 7, diagnoses: `removeEncounterDiagnosis` with a reason (small).
3. Step 8, note: AI draft from dictation with `createNoteDraft` (medium; #255's fields are on main).
4. Step 9, prescribe: pharmacy choice with `listPharmacies` (small).
5. Step 11, check-out: copay with `recordPayment` (medium; new section, needs your OK).
6. My Day: the doctor's own schedule from `practitionerId` on `/me` (#221) (medium).
| 77 | Doctors' portal queue and My Day (gap 77, Vimal's wording on #274): with the API they read the visit's step (`visitStatus`, not `status`). Checked in is "Waiting", timed from check-in; roomed is "Roomed · {room}", timed "in room" from rooming; with the provider is "With doctor", with its timer; checked out leaves the queue (no Seen column); not yet checked in is "Booked". My Day's cards read "Waiting or roomed" and "With doctor" and filter by the step; the board column and the queue header use the same words | Vimal (wording) | OPD queue, My Day | Done |
| 79 | Doctors' portal My Day with the API (2026-11-11): today's bookings, the status board, the provider's own day (`GET /me`, #221) and the month calendar; the sample day (its own date, the Indian hospital, ICU and Critical cards) no longer shows. Hidden because no service exists: **Morning brief** (the AI chart summary, `getChartSummary`, Vimal #264/#267), and the rail and phone tabs for orders and results (Thulasi), imaging, inpatients, discharge and telehealth (not in the U.S. demo). **To-do** says reminders can't be saved yet (no inbox or reminders API: `getInboxSummary` isn't built, Anand) | — | My Day, rail | Connected |
| 80 | Diagnosis removal (step 7, 2026-11-11): a saved diagnosis on Problems and coding has a remove button (the prescription line's trash pill) with the API; it asks why (required, three characters or more) and calls `removeEncounterDiagnosis` with the reason (D24: entered in error, kept for audit). Only before the note is signed; afterwards the server refuses and its message is shown | — | Problems and coding | Connected |
| 81 | Pharmacy choice (step 9, 2026-11-11): a Pharmacy card under the prescription on the prescribing screen, with the API. It starts from the patient's preferred pharmacy on their record (`getPatient`); any other is found in the pharmacy directory by name or ZIP (`listPharmacies`, Thulasi). The choice goes on every draft line (`updatePrescription` with If-Match) and on new drafts (`createPrescription`); Sign is blocked until a pharmacy is chosen, since the server refuses to sign without one (`/pharmacyId` required). **Blocked:** making the choice the patient's preferred pharmacy for next time needs `setPreferredPharmacy` (PUT, `patients:update`), which is in the contract but not built (Vimal) | Vimal (setPreferredPharmacy) | Prescribing | Connected, except saving the preferred pharmacy |
| 82 | Prescribing: a draft made in another browser or tab isn't listed on the screen (no "prescriptions of an encounter" read; draft IDs are kept per visit in this tab, #93), and the banner's payer pill is cut off at 390 px | Vimal (read), Minalini (pill) | Prescribing | Open |
| 83 | Prescribing end to end (step 9, 3e, 2026-11-11): Sign shows only for MD and APP (D110). A refused Sign says what to do for 409, 412, 428, 403 and a stale safety check (`safety-check-stale`); after 409, 412 or 428 it reads the lines again, and after 412, 428 or a stale check it runs the safety check again (D99). A reopened tab takes the pharmacy saved on the lines, named from the patient's preferred pharmacy or the directory's first page (there is no pharmacy read by ID, #93). The days supply offers 30 and 90 days. With the API, the signed footer shows a U.S. date and time with no HPR number (the session carries no NPI) and no A5 bilingual print | Vimal (pharmacy by ID, the signer's NPI) | Prescribing | Open |
| 84 | UI note (prescribing): an MA (any role without MD or APP) can type into a draft's fields, and the server then refuses the save (D110: drafts are MD and APP only; MA has no `prescriptions:create|update`). Only the Sign button is hidden; the fields stay editable for now | Minalini | Prescribing | Open |
| 85 | Problem list (#280, Vimal on #85): the record's Current condition page (S-06-15) and its tab count read `listProblems` with the API, `limit` 100 and `cursor` (up to 5 pages), newest first, entered-in-error left out. A role without the read sees "Your role can't read the problem list"; a restricted chart opens the sealed "Restricted chart" card (renamed from "Restricted record"). The front desk never reaches it: the record banner's allergies read refuses FD first. Read only; writes come after the demo. UI approved for the empty state only (2026-11-11): the populated list, the 403 wording and the "Restricted chart" card still need a live check on the preview server after the #278 reset. | Vimal (writes) | Current condition | Open (preview check) |
| 86 | Family, social and surgical history (`listFamilyHistory`, `listSocialHistory`, `listSurgicalHistory`, #280) have no screen in the doctors' portal, and `getProblem` (one problem with its ETag) has no detail screen; none is wired. Asked on #85 which screen, if any, should show them | Vimal (decision) | Patient record | Open |
