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
